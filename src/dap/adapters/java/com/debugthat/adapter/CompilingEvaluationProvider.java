package com.debugthat.adapter;

import com.microsoft.java.debug.core.IEvaluatableBreakpoint;
import com.microsoft.java.debug.core.adapter.IDebugAdapterContext;
import com.microsoft.java.debug.core.adapter.IEvaluationProvider;
import com.microsoft.java.debug.core.adapter.IHotCodeReplaceProvider;

import com.sun.jdi.*;

import javax.tools.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.*;

/**
 * Full expression evaluation via ECJ compilation + JDI bytecode injection.
 *
 * Flow: generate synthetic class → compile with ECJ in-memory → create
 * SecureClassLoader in debuggee via JDI → defineClass → invoke eval method.
 */
public class CompilingEvaluationProvider implements IEvaluationProvider {

    private static final String THIS_PARAM = "__dbg_this";
    private static final Pattern THIS_PATTERN = Pattern.compile("\\bthis\\b");
    private static final String EVAL_CLASS_PREFIX = "__DbgEval_";
    private static final String HOTPATCH_PREPARE_PREFIX = "__HOTPATCH_PREPARE__";
    private CompilingHotCodeReplaceProvider hcrProvider;

    private final AtomicInteger evalCounter = new AtomicInteger(0);
    private final Set<Long> activeEvals = ConcurrentHashMap.newKeySet();
    private volatile String cachedClasspath = null;
    private final ExecutorService evalExecutor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "debug-that-eval");
        t.setDaemon(true);
        return t;
    });

    @Override
    public void initialize(IDebugAdapterContext context, Map<String, Object> options) {
        // Get reference to the HCR provider for hotpatch preparation
        IHotCodeReplaceProvider provider = context.getProvider(IHotCodeReplaceProvider.class);
        if (provider instanceof CompilingHotCodeReplaceProvider compilingProvider) {
            this.hcrProvider = compilingProvider;
        }
    }

    @Override
    public CompletableFuture<Value> evaluate(String expression, ThreadReference thread, int depth) {
        // Hot code replace preparation — stores file/source/classpath on HCR provider.
        // Actual redefine happens via the redefineClasses DAP request (separate round trip).
        if (expression.startsWith(HOTPATCH_PREPARE_PREFIX)) {
            return CompletableFuture.supplyAsync(() -> {
                try {
                    return prepareHotpatch(expression.substring(HOTPATCH_PREPARE_PREFIX.length()), thread);
                } catch (RuntimeException e) {
                    throw e;
                } catch (Exception e) {
                    throw new RuntimeException(e.getMessage(), e);
                }
            }, evalExecutor);
        }

        return CompletableFuture.supplyAsync(() -> {
            long threadId = thread.uniqueID();
            activeEvals.add(threadId);
            try {
                StackFrame frame = thread.frame(depth);
                ObjectReference thisObj = frame.thisObject();
                return compileAndInvoke(expression, frame, thread, thisObj);
            } catch (RuntimeException e) {
                throw e;
            } catch (Exception e) {
                throw new RuntimeException("Evaluation failed: " + e.getMessage(), e);
            } finally {
                activeEvals.remove(threadId);
            }
        }, evalExecutor);
    }

    @Override
    public CompletableFuture<Value> evaluate(String expression, ObjectReference thisContext,
            ThreadReference thread) {
        return CompletableFuture.supplyAsync(() -> {
            long threadId = thread.uniqueID();
            activeEvals.add(threadId);
            try {
                StackFrame frame = thread.frame(0);
                return compileAndInvoke(expression, frame, thread, thisContext);
            } catch (RuntimeException e) {
                throw e;
            } catch (Exception e) {
                throw new RuntimeException("Evaluation failed: " + e.getMessage(), e);
            } finally {
                activeEvals.remove(threadId);
            }
        }, evalExecutor);
    }

    @Override
    public CompletableFuture<Value> evaluateForBreakpoint(IEvaluatableBreakpoint breakpoint,
            ThreadReference thread) {
        String expression = breakpoint.getCondition();
        if (expression == null || expression.isEmpty()) {
            expression = breakpoint.getLogMessage();
        }
        if (expression == null) {
            return CompletableFuture.completedFuture(null);
        }
        return evaluate(expression, thread, 0);
    }

    @Override
    public CompletableFuture<Value> invokeMethod(ObjectReference obj, String methodName,
            String methodSignature, Value[] args, ThreadReference thread, boolean invokeSuper) {
        return CompletableFuture.supplyAsync(() -> {
            try {
                List<Method> methods = obj.referenceType().methodsByName(methodName);
                Method method = null;
                for (Method m : methods) {
                    if (methodSignature == null || m.signature().equals(methodSignature)) {
                        method = m;
                        break;
                    }
                }
                if (method == null) {
                    throw new RuntimeException("Method not found: " + methodName);
                }
                List<Value> argList = args != null ? Arrays.asList(args) : Collections.emptyList();
                int options = invokeSuper ? ObjectReference.INVOKE_NONVIRTUAL : 0;
                return obj.invokeMethod(thread, method, argList, options);
            } catch (Exception e) {
                throw new RuntimeException("Method invocation failed: " + e.getMessage(), e);
            }
        }, evalExecutor);
    }

    @Override
    public boolean isInEvaluation(ThreadReference thread) {
        return activeEvals.contains(thread.uniqueID());
    }

    @Override
    public void clearState(ThreadReference thread) {
        activeEvals.remove(thread.uniqueID());
    }

    // ── Core compile+inject pipeline ──

    private Value compileAndInvoke(String expression, StackFrame frame,
            ThreadReference thread, ObjectReference thisObj) throws Exception {
        VirtualMachine vm = thread.virtualMachine();

        // Collect local variables and their VALUES before any JDI method invocation.
        // JDI invocations (getDebuggeeClasspath, injectAndInvoke) resume the thread,
        // which invalidates the StackFrame — so we must snapshot everything now.
        // Only include locals referenced by the expression to avoid unnecessary type resolution.
        List<LocalVariable> locals;
        List<Value> localValues;
        try {
            List<LocalVariable> allLocals = frame.visibleVariables();
            locals = new ArrayList<>();
            localValues = new ArrayList<>();
            Map<LocalVariable, Value> valueMap = frame.getValues(allLocals);
            for (LocalVariable local : allLocals) {
                if (expressionReferencesVariable(expression, local.name())) {
                    locals.add(local);
                    localValues.add(valueMap.get(local));
                }
            }
        } catch (AbsentInformationException e) {
            locals = Collections.emptyList();
            localValues = Collections.emptyList();
        }

        // Generate unique class name
        int evalId = evalCounter.incrementAndGet();
        String className = EVAL_CLASS_PREFIX + evalId;

        // Preprocess expression: replace 'this' with parameter name
        String processedExpr = expression;
        if (thisObj != null) {
            processedExpr = THIS_PATTERN.matcher(expression).replaceAll(THIS_PARAM);
        }

        // Generate source
        String source = generateSource(processedExpr, className, locals, thisObj);

        // Get debuggee classpath (this invokes a method on the debuggee — invalidates frame)
        String classpath = getDebuggeeClasspath(thread);

        // Compile — try as return expression first, then as void statement
        Map<String, byte[]> compiled = compileSource(source, className, classpath);
        if (compiled == null) {
            // Check if failure is due to private field access — rewrite with reflection
            String compileErr = getCompileError(source, className, classpath);
            if (compileErr.contains("not visible")) {
                String reflExpr = rewritePrivateFieldAccess(processedExpr, locals, localValues, thisObj);
                if (reflExpr != null && !reflExpr.equals(processedExpr)) {
                    String reflSource = generateSourceWithReflectionHelper(reflExpr, className, locals, thisObj);
                    compiled = compileSource(reflSource, className, classpath);
                    if (compiled == null) {
                        // __dbg_get returns Object — void fallback unlikely, but try
                        String reflVoidSource = generateVoidSource(reflExpr, className, locals, thisObj);
                        compiled = compileSource(reflVoidSource, className, classpath);
                    }
                }
                if (compiled == null) {
                    throw new RuntimeException(compileErr);
                }
            } else {
                // Not a visibility issue — try void statement
                String voidSource = generateVoidSource(processedExpr, className, locals, thisObj);
                compiled = compileSource(voidSource, className, classpath);
                if (compiled == null) {
                    throw new RuntimeException(compileErr);
                }
            }
        }

        // Inject all classes and invoke (uses pre-captured localValues, not the stale frame)
        return injectAndInvoke(compiled, className, localValues, thisObj, thread, vm);
    }

    // ── Source generation ──

    private String generateSource(String expression, String className,
            List<LocalVariable> locals, ObjectReference thisObj) {
        StringBuilder sb = new StringBuilder();
        sb.append("public class ").append(className).append(" {\n");
        sb.append("    public static Object __eval(");
        sb.append(buildParamList(locals, thisObj));
        sb.append(") throws Throwable {\n");
        sb.append("        return (").append(expression).append(");\n");
        sb.append("    }\n");
        sb.append("}\n");
        return sb.toString();
    }

    private String generateVoidSource(String expression, String className,
            List<LocalVariable> locals, ObjectReference thisObj) {
        StringBuilder sb = new StringBuilder();
        sb.append("public class ").append(className).append(" {\n");
        sb.append("    public static Object __eval(");
        sb.append(buildParamList(locals, thisObj));
        sb.append(") throws Throwable {\n");
        sb.append("        ").append(expression).append(";\n");
        sb.append("        return null;\n");
        sb.append("    }\n");
        sb.append("}\n");
        return sb.toString();
    }

    /** Check if expression references a variable name (word boundary match). */
    private boolean expressionReferencesVariable(String expression, String varName) {
        return Pattern.compile("\\b" + Pattern.quote(varName) + "\\b").matcher(expression).find();
    }

    // ── Private field access rewriting ──

    /**
     * When compilation fails with "not visible", rewrite obj.field accesses
     * to use reflection: __dbg_get(obj, "field").
     * Works for both this-context (__dbg_this.field) and local variables (obj.field).
     */
    /** Map of primitive type → boxed wrapper for casts in reflection results. */
    private static final Map<String, String> PRIMITIVE_TO_BOXED = Map.of(
            "boolean", "Boolean", "byte", "Byte", "char", "Character",
            "short", "Short", "int", "Integer", "long", "Long",
            "float", "Float", "double", "Double");

    private String rewritePrivateFieldAccess(String expression, List<LocalVariable> locals,
            List<Value> localValues, ObjectReference thisObj) {
        // Build a map of parameter name → (field name → field type name)
        Map<String, Map<String, String>> paramFields = new HashMap<>();

        // Add locals that are object references
        for (int i = 0; i < locals.size(); i++) {
            Value val = localValues.get(i);
            if (val instanceof ObjectReference) {
                Map<String, String> fieldTypes = new HashMap<>();
                for (Field f : ((ObjectReference) val).referenceType().allFields()) {
                    fieldTypes.put(f.name(), f.typeName());
                }
                paramFields.put(locals.get(i).name(), fieldTypes);
            }
        }

        // Add this-context
        if (thisObj != null) {
            Map<String, String> fieldTypes = new HashMap<>();
            for (Field f : thisObj.referenceType().allFields()) {
                fieldTypes.put(f.name(), f.typeName());
            }
            paramFields.put(THIS_PARAM, fieldTypes);
        }

        if (paramFields.isEmpty()) return null;

        // Build pattern: (paramName1|paramName2|...).identifier (not followed by '(')
        String paramAlternation = paramFields.keySet().stream()
                .map(Pattern::quote)
                .collect(Collectors.joining("|"));
        Pattern fieldAccessPattern = Pattern.compile(
                "\\b(" + paramAlternation + ")\\.([a-zA-Z_$][a-zA-Z0-9_$]*)(?!\\s*\\()");

        Matcher m = fieldAccessPattern.matcher(expression);
        StringBuilder sb = new StringBuilder();
        boolean changed = false;
        while (m.find()) {
            String paramName = m.group(1);
            String fieldName = m.group(2);
            Map<String, String> fields = paramFields.get(paramName);
            if (fields != null && fields.containsKey(fieldName)) {
                String typeName = fields.get(fieldName);
                String castType = PRIMITIVE_TO_BOXED.getOrDefault(typeName, typeName);
                String replacement = "((" + castType + ")__dbg_get("
                        + Matcher.quoteReplacement(paramName) + ", \"" + fieldName + "\"))";
                m.appendReplacement(sb, Matcher.quoteReplacement(replacement));
                changed = true;
            }
        }
        if (!changed) return null;
        m.appendTail(sb);
        return sb.toString();
    }

    /** Generate source with the __dbg_get reflection helper included. */
    private String generateSourceWithReflectionHelper(String expression, String className,
            List<LocalVariable> locals, ObjectReference thisObj) {
        StringBuilder sb = new StringBuilder();
        sb.append("public class ").append(className).append(" {\n");
        sb.append("    public static Object __eval(");
        sb.append(buildParamList(locals, thisObj));
        sb.append(") throws Throwable {\n");
        sb.append("        return (").append(expression).append(");\n");
        sb.append("    }\n");
        sb.append("    private static Object __dbg_get(Object obj, String fieldName) throws Throwable {\n");
        sb.append("        Class<?> cls = obj.getClass();\n");
        sb.append("        while (cls != null) {\n");
        sb.append("            try {\n");
        sb.append("                java.lang.reflect.Field f = cls.getDeclaredField(fieldName);\n");
        sb.append("                f.setAccessible(true);\n");
        sb.append("                return f.get(obj);\n");
        sb.append("            } catch (NoSuchFieldException e) {\n");
        sb.append("                cls = cls.getSuperclass();\n");
        sb.append("            }\n");
        sb.append("        }\n");
        sb.append("        throw new NoSuchFieldException(fieldName);\n");
        sb.append("    }\n");
        sb.append("}\n");
        return sb.toString();
    }

    private String buildParamList(List<LocalVariable> locals, ObjectReference thisObj) {
        List<String> params = new ArrayList<>();
        for (LocalVariable local : locals) {
            // typeName() returns from debug metadata without loading the class (no ClassNotLoadedException)
            params.add(local.typeName() + " " + local.name());
        }
        if (thisObj != null) {
            params.add(thisObj.referenceType().name() + " " + THIS_PARAM);
        }
        return String.join(", ", params);
    }

    // ── Compilation with ECJ via temp files ──

    private Map<String, byte[]> compileSource(String source, String className, String classpath) {
        Path tempDir = null;
        try {
            tempDir = Files.createTempDirectory("dbg-eval");
            return compileToTempDir(source, className, classpath, tempDir, null);
        } catch (IOException e) {
            return null;
        } finally {
            deleteTempDir(tempDir);
        }
    }

    private String getCompileError(String source, String className, String classpath) {
        Path tempDir = null;
        try {
            tempDir = Files.createTempDirectory("dbg-eval");
            DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
            compileToTempDir(source, className, classpath, tempDir, diagnostics);
            return diagnostics.getDiagnostics().stream()
                    .filter(d -> d.getKind() == Diagnostic.Kind.ERROR)
                    .map(d -> {
                        String msg = d.getMessage(null);
                        // Strip synthetic class/line references
                        return msg.replaceAll("(?i)" + Pattern.quote(className) + "[.:]?\\s*", "");
                    })
                    .collect(Collectors.joining("; "));
        } catch (IOException e) {
            return "Compilation failed: " + e.getMessage();
        } finally {
            deleteTempDir(tempDir);
        }
    }

    private Map<String, byte[]> compileToTempDir(String source, String className,
            String classpath, Path tempDir,
            DiagnosticCollector<JavaFileObject> diagnosticsOut) throws IOException {
        // Write source
        Path sourceFile = tempDir.resolve(className + ".java");
        Files.writeString(sourceFile, source);

        // Get compiler (prefer ECJ on classpath, fall back to javac)
        JavaCompiler compiler = findCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics =
                diagnosticsOut != null ? diagnosticsOut : new DiagnosticCollector<>();
        StandardJavaFileManager fileManager = compiler.getStandardFileManager(diagnostics, null, null);

        // Set classpath
        if (classpath != null && !classpath.isEmpty()) {
            List<File> cpFiles = Arrays.stream(classpath.split(File.pathSeparator))
                    .map(File::new)
                    .filter(File::exists)
                    .collect(Collectors.toList());
            fileManager.setLocation(StandardLocation.CLASS_PATH, cpFiles);
        }
        fileManager.setLocation(StandardLocation.CLASS_OUTPUT, List.of(tempDir.toFile()));

        Iterable<? extends JavaFileObject> units = fileManager.getJavaFileObjects(sourceFile.toFile());
        JavaCompiler.CompilationTask task = compiler.getTask(
                null, fileManager, diagnostics,
                List.of("-source", "17", "-target", "17", "-nowarn"),
                null, units);

        boolean success = task.call();
        fileManager.close();

        if (!success) {
            return null;
        }

        // Read all generated .class files
        Map<String, byte[]> result = new HashMap<>();
        try (Stream<Path> walk = Files.walk(tempDir)) {
            walk.filter(p -> p.toString().endsWith(".class")).forEach(p -> {
                try {
                    String name = tempDir.relativize(p).toString()
                            .replace(".class", "").replace(File.separatorChar, '.');
                    result.put(name, Files.readAllBytes(p));
                } catch (IOException e) {
                    throw new UncheckedIOException(e);
                }
            });
        }
        return result;
    }

    private JavaCompiler findCompiler() {
        // Try ECJ first (on classpath)
        try {
            Class<?> ecjClass = Class.forName("org.eclipse.jdt.internal.compiler.tool.EclipseCompiler");
            return (JavaCompiler) ecjClass.getDeclaredConstructor().newInstance();
        } catch (Exception ignored) {}
        // Fall back to javac
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        if (javac != null) return javac;
        throw new RuntimeException("No Java compiler found. Ensure JDK 17+ is installed.");
    }

    private void deleteTempDir(Path dir) {
        if (dir == null) return;
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> {
                try { Files.deleteIfExists(p); } catch (IOException ignored) {}
            });
        } catch (IOException ignored) {}
    }

    // ── Debuggee classpath resolution ──

    /**
     * Get the debuggee's classpath via JDWP query (no thread resumption, safe at breakpoints).
     * All HotSpot-based JVMs (OpenJDK, Oracle, Corretto, Zulu, GraalVM) implement
     * PathSearchingVirtualMachine. Cached after first retrieval.
     */
    private String getDebuggeeClasspath(ThreadReference thread) {
        if (cachedClasspath != null) {
            return cachedClasspath;
        }

        VirtualMachine vm = thread.virtualMachine();
        if (vm instanceof com.sun.jdi.PathSearchingVirtualMachine psvm) {
            List<String> cp = psvm.classPath();
            if (cp != null && !cp.isEmpty()) {
                cachedClasspath = String.join(File.pathSeparator, cp);
                return cachedClasspath;
            }
        }

        throw new RuntimeException(
                "Cannot retrieve debuggee classpath: VM does not implement PathSearchingVirtualMachine. "
                        + "Only HotSpot-based JVMs (OpenJDK, Oracle, Corretto, Zulu) are supported.");
    }

    // ── Hot code replace preparation ──

    /**
     * Prepare a hotpatch by storing the file/source and classpath on the HCR provider.
     * The actual redefineClasses() call happens via the redefineClasses DAP request,
     * which avoids the deadlock that occurs when calling vm.redefineClasses() inside
     * the evaluate CompletableFuture (java-debug framework event dispatch conflict).
     *
     * Payload format: file_path\nsource_content (source empty for .class input).
     */
    private Value prepareHotpatch(String payload, ThreadReference thread) throws Exception {
        if (hcrProvider == null) {
            throw new RuntimeException("Hot code replace provider not available.");
        }

        int nl = payload.indexOf('\n');
        String file = nl >= 0 ? payload.substring(0, nl) : payload;
        String source = nl >= 0 && nl < payload.length() - 1 ? payload.substring(nl + 1) : "";

        // Get classpath via JDWP query (no thread resumption — safe at breakpoints).
        // Falls back to invokeMethod only if PathSearchingVirtualMachine is unavailable.
        String classpath = getDebuggeeClasspath(thread);

        hcrProvider.prepareHotpatch(file, source, classpath);

        VirtualMachine vm = thread.virtualMachine();
        return vm.mirrorOf("prepared");
    }

    // ── Bytecode injection via JDI ──

    private Value injectAndInvoke(Map<String, byte[]> classFiles, String mainClassName,
            List<Value> localValues, ObjectReference thisObj,
            ThreadReference thread, VirtualMachine vm) throws Exception {

        // Use the enclosing type's classloader (Eclipse style) — all user types are already
        // loaded through it, avoiding ClassNotLoadedException during method resolution.
        // Unique class names (__DbgEval_N) prevent naming collisions.
        StackFrame currentFrame = thread.frame(0);
        ClassLoaderReference loader = currentFrame.location().declaringType().classLoader();

        // Find ClassLoader.defineClass(String, byte[], int, int)
        ClassType classLoaderType = (ClassType) vm.classesByName("java.lang.ClassLoader").get(0);
        Method defineClassMethod = classLoaderType.methodsByName("defineClass").stream()
                .filter(m -> {
                    List<String> argTypes = m.argumentTypeNames();
                    return argTypes.size() == 4
                            && argTypes.get(0).equals("java.lang.String")
                            && argTypes.get(1).equals("byte[]")
                            && argTypes.get(2).equals("int")
                            && argTypes.get(3).equals("int");
                })
                .findFirst()
                .orElseThrow(() -> new RuntimeException("ClassLoader.defineClass not found"));

        // Inject all class files (main + any lambdas/inner classes)
        for (Map.Entry<String, byte[]> entry : classFiles.entrySet()) {
            String name = entry.getKey().replace('/', '.');
            byte[] bytes = entry.getValue();

            // Mirror the byte array into the debuggee
            ArrayType byteArrayType = (ArrayType) vm.classesByName("byte[]").get(0);
            ArrayReference byteArray = byteArrayType.newInstance(bytes.length);
            List<Value> byteValues = new ArrayList<>(bytes.length);
            for (byte b : bytes) {
                byteValues.add(vm.mirrorOf(b));
            }
            byteArray.setValues(byteValues);

            // defineClass(name, bytes, 0, len) — JDWP bypasses protected access
            loader.invokeMethod(thread, defineClassMethod,
                    List.of(vm.mirrorOf(name), byteArray, vm.mirrorOf(0), vm.mirrorOf(bytes.length)),
                    ObjectReference.INVOKE_SINGLE_THREADED);
        }

        // Force class initialization via Class.forName(name, true, loader)
        ClassType classClass = (ClassType) vm.classesByName("java.lang.Class").get(0);
        Method forNameMethod = classClass.methodsByName("forName").stream()
                .filter(m -> m.argumentTypeNames().size() == 3)
                .findFirst()
                .orElseThrow(() -> new RuntimeException("Class.forName(String,boolean,ClassLoader) not found"));
        classClass.invokeMethod(thread, forNameMethod,
                List.of(vm.mirrorOf(mainClassName), vm.mirrorOf(true), loader),
                ObjectReference.INVOKE_SINGLE_THREADED);

        // Now the class is prepared — find it by name
        ClassType evalClassType = null;
        List<ReferenceType> types = vm.classesByName(mainClassName);
        for (ReferenceType t : types) {
            if (t instanceof ClassType) {
                evalClassType = (ClassType) t;
                break;
            }
        }
        if (evalClassType == null) {
            throw new RuntimeException("Cannot find eval class type after initialization");
        }

        Method evalMethod = evalClassType.methodsByName("__eval").stream()
                .findFirst()
                .orElseThrow(() -> new RuntimeException("__eval method not found"));

        // Build argument list from pre-captured local values + this
        List<Value> args = new ArrayList<>(localValues);
        if (thisObj != null) {
            args.add(thisObj);
        }

        // Invoke __eval
        return evalClassType.invokeMethod(thread, evalMethod, args,
                ObjectReference.INVOKE_SINGLE_THREADED);
    }

}
