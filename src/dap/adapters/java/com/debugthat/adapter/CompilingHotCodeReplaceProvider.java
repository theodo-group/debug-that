package com.debugthat.adapter;

import com.microsoft.java.debug.core.adapter.HotCodeReplaceEvent;
import com.microsoft.java.debug.core.adapter.IDebugAdapterContext;
import com.microsoft.java.debug.core.adapter.IHotCodeReplaceProvider;

import com.sun.jdi.*;

import io.reactivex.Observable;
import io.reactivex.subjects.PublishSubject;

import javax.tools.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.function.Consumer;
import java.util.stream.*;

/**
 * Hot code replace provider that compiles .java sources with ECJ or reads .class
 * bytecode, then redefines classes in the JVM via VirtualMachine.redefineClasses().
 *
 * Flow:
 *   1. TypeScript sets pending hotpatch via evaluate(__HOTPATCH_PREPARE__...)
 *   2. TypeScript sends redefineClasses DAP request
 *   3. This provider reads the pending data, compiles/reads, and redefines
 */
public class CompilingHotCodeReplaceProvider implements IHotCodeReplaceProvider {

    private IDebugAdapterContext context;
    private Consumer<List<String>> redefinedCallback;
    private final PublishSubject<HotCodeReplaceEvent> eventSubject = PublishSubject.create();

    // Pending hotpatch request set by the evaluate handler
    private volatile String pendingFile;
    private volatile String pendingSource;
    private volatile String pendingClasspath;

    @Override
    public void initialize(IDebugAdapterContext context, Map<String, Object> options) {
        this.context = context;
    }

    @Override
    public void onClassRedefined(Consumer<List<String>> consumer) {
        this.redefinedCallback = consumer;
    }

    /**
     * Called by the evaluate handler to prepare a hotpatch. Stores the file/source
     * and classpath for the next redefineClasses() call.
     */
    public void prepareHotpatch(String file, String source, String classpath) {
        this.pendingFile = file;
        this.pendingSource = source;
        this.pendingClasspath = classpath;
    }

    @Override
    public CompletableFuture<List<String>> redefineClasses() {
        return CompletableFuture.supplyAsync(() -> {
            try {
                return doRedefine();
            } catch (RuntimeException e) {
                throw e;
            } catch (Exception e) {
                throw new RuntimeException(e.getMessage(), e);
            }
        });
    }

    private List<String> doRedefine() throws Exception {
        String file = this.pendingFile;
        String source = this.pendingSource;
        String classpath = this.pendingClasspath;

        // Clear pending state
        this.pendingFile = null;
        this.pendingSource = null;
        this.pendingClasspath = null;

        if (file == null) {
            throw new RuntimeException("No hotpatch prepared. Call evaluate with __HOTPATCH_PREPARE__ first.");
        }

        VirtualMachine vm = context.getDebugSession().getVM();
        if (!vm.canRedefineClasses()) {
            throw new RuntimeException(
                    "This JVM does not support class redefinition. Restart the application to apply changes.");
        }

        Map<String, byte[]> classFiles;
        if (file.endsWith(".class")) {
            classFiles = readClassFilesFromDisk(file);
        } else {
            classFiles = compileHotpatchSource(file, source, classpath);
        }

        // Build redefine map: find loaded ReferenceType for each class
        Map<ReferenceType, byte[]> redefineMap = new HashMap<>();
        List<String> redefinedNames = new ArrayList<>();

        for (Map.Entry<String, byte[]> entry : classFiles.entrySet()) {
            String className = entry.getKey();
            List<ReferenceType> types = vm.classesByName(className);
            if (types.isEmpty()) continue;
            redefineMap.put(types.get(0), entry.getValue());
            redefinedNames.add(className);
        }

        if (redefineMap.isEmpty()) {
            throw new RuntimeException("No loaded classes found to redefine. "
                    + "Ensure the class is loaded in the JVM.");
        }

        // Disable breakpoints before redefine (IntelliJ approach) to prevent
        // the JDWP agent from firing events during the class redefinition safepoint.
        var bpManager = context.getBreakpointManager();
        var enabledRequests = new ArrayList<com.sun.jdi.request.EventRequest>();
        for (var bp : bpManager.getBreakpoints()) {
            for (var req : bp.requests()) {
                if (req.isEnabled()) {
                    enabledRequests.add(req);
                    req.disable();
                }
            }
        }

        try {
            vm.redefineClasses(redefineMap);
        } catch (UnsupportedOperationException e) {
            String msg = e.getMessage() != null ? e.getMessage() : "";
            throw new RuntimeException(
                    "Structural changes not supported by HotSwap "
                            + "(cannot add/remove methods or fields). "
                            + "Restart the application to apply changes. " + msg);
        } catch (Exception e) {
            String msg = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
            if (msg.contains("add") || msg.contains("delete") || msg.contains("schema")
                    || msg.contains("hierarchy") || msg.contains("not implemented")) {
                throw new RuntimeException(
                        "Structural changes not supported by HotSwap "
                                + "(cannot add/remove methods or fields). "
                                + "Restart the application to apply changes. " + msg);
            }
            throw new RuntimeException("Hot code replace failed: " + msg);
        } finally {
            // Re-enable breakpoints. Some may have been invalidated by redefineClasses
            // (JDI spec: breakpoints in redefined classes are cleared).
            for (var req : enabledRequests) {
                try { req.enable(); } catch (Exception ignored) {}
            }
        }

        // Notify callback
        if (redefinedCallback != null) {
            redefinedCallback.accept(redefinedNames);
        }

        // Emit event
        eventSubject.onNext(new HotCodeReplaceEvent(
                HotCodeReplaceEvent.EventType.END, "Replaced " + redefinedNames.size() + " class(es)"));

        return redefinedNames;
    }

    @Override
    public Observable<HotCodeReplaceEvent> getEventHub() {
        return eventSubject;
    }

    // ── Compilation ──

    private Map<String, byte[]> compileHotpatchSource(String file, String source, String classpath) {
        String fileName = Paths.get(file).getFileName().toString();
        String simpleClassName = fileName.replace(".java", "");

        Path tempDir = null;
        try {
            tempDir = Files.createTempDirectory("dbg-hcr");
            Map<String, byte[]> compiled = compileToTempDir(source, simpleClassName, classpath, tempDir);
            if (compiled == null) {
                String errors = getCompileErrors(source, simpleClassName, classpath, tempDir);
                throw new RuntimeException("Compilation failed: " + errors
                        + ". Tip: build your project and use 'dbg hotpatch path/to/YourClass.class' instead.");
            }
            return compiled;
        } catch (IOException e) {
            throw new RuntimeException("Compilation failed: " + e.getMessage());
        } finally {
            deleteTempDir(tempDir);
        }
    }

    private Map<String, byte[]> compileToTempDir(String source, String className,
            String classpath, Path tempDir) throws IOException {
        Path sourceFile = tempDir.resolve(className + ".java");
        Files.writeString(sourceFile, source);

        JavaCompiler compiler = findCompiler();
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        StandardJavaFileManager fileManager = compiler.getStandardFileManager(diagnostics, null, null);

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

        if (!success) return null;

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

    private String getCompileErrors(String source, String className, String classpath, Path tempDir) {
        try {
            DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
            Path sourceFile = tempDir.resolve(className + ".java");
            Files.writeString(sourceFile, source);

            JavaCompiler compiler = findCompiler();
            StandardJavaFileManager fileManager = compiler.getStandardFileManager(diagnostics, null, null);

            if (classpath != null && !classpath.isEmpty()) {
                List<File> cpFiles = Arrays.stream(classpath.split(File.pathSeparator))
                        .map(File::new).filter(File::exists).collect(Collectors.toList());
                fileManager.setLocation(StandardLocation.CLASS_PATH, cpFiles);
            }
            fileManager.setLocation(StandardLocation.CLASS_OUTPUT, List.of(tempDir.toFile()));

            Iterable<? extends JavaFileObject> units = fileManager.getJavaFileObjects(sourceFile.toFile());
            JavaCompiler.CompilationTask task = compiler.getTask(
                    null, fileManager, diagnostics,
                    List.of("-source", "17", "-target", "17", "-nowarn"), null, units);
            task.call();
            fileManager.close();

            return diagnostics.getDiagnostics().stream()
                    .filter(d -> d.getKind() == Diagnostic.Kind.ERROR)
                    .map(d -> d.getMessage(null))
                    .collect(Collectors.joining("; "));
        } catch (IOException e) {
            return e.getMessage();
        }
    }

    private JavaCompiler findCompiler() {
        try {
            Class<?> ecjClass = Class.forName("org.eclipse.jdt.internal.compiler.tool.EclipseCompiler");
            return (JavaCompiler) ecjClass.getDeclaredConstructor().newInstance();
        } catch (Exception ignored) {}
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        if (javac != null) return javac;
        throw new RuntimeException("No Java compiler found. Ensure JDK 17+ is installed.");
    }

    // ── .class file reading ──

    private Map<String, byte[]> readClassFilesFromDisk(String classFilePath) throws IOException {
        Map<String, byte[]> result = new HashMap<>();
        Path path = Paths.get(classFilePath);
        byte[] bytes = Files.readAllBytes(path);
        String className = parseClassNameFromBytecode(bytes);
        result.put(className, bytes);

        // Auto-detect inner class siblings
        String baseName = path.getFileName().toString().replace(".class", "");
        Path dir = path.getParent();
        if (dir != null) {
            try (Stream<Path> siblings = Files.list(dir)) {
                siblings.filter(p -> {
                    String name = p.getFileName().toString();
                    return name.startsWith(baseName + "$") && name.endsWith(".class");
                }).forEach(p -> {
                    try {
                        byte[] innerBytes = Files.readAllBytes(p);
                        String innerName = parseClassNameFromBytecode(innerBytes);
                        result.put(innerName, innerBytes);
                    } catch (IOException ignored) {}
                });
            }
        }
        return result;
    }

    static String parseClassNameFromBytecode(byte[] bytes) {
        int offset = 8; // skip magic(4) + minor(2) + major(2)
        int cpCount = readU2(bytes, offset);
        offset += 2;

        String[] utf8s = new String[cpCount];
        int[] classNameIndices = new int[cpCount];

        for (int i = 1; i < cpCount; i++) {
            int tag = bytes[offset++] & 0xFF;
            switch (tag) {
                case 1: // Utf8
                    int len = readU2(bytes, offset); offset += 2;
                    utf8s[i] = new String(bytes, offset, len, java.nio.charset.StandardCharsets.UTF_8);
                    offset += len; break;
                case 7: // Class
                    classNameIndices[i] = readU2(bytes, offset); offset += 2; break;
                case 3: case 4: offset += 4; break;
                case 5: case 6: offset += 8; i++; break;
                case 8: offset += 2; break;
                case 9: case 10: case 11: case 12: offset += 4; break;
                case 15: offset += 3; break;
                case 16: offset += 2; break;
                case 17: case 18: offset += 4; break;
                case 19: case 20: offset += 2; break;
                default: throw new RuntimeException("Unknown constant pool tag: " + tag);
            }
        }

        offset += 2; // access_flags
        int thisClassIdx = readU2(bytes, offset);
        int nameIdx = classNameIndices[thisClassIdx];
        return utf8s[nameIdx].replace('/', '.');
    }

    private static int readU2(byte[] data, int offset) {
        return ((data[offset] & 0xFF) << 8) | (data[offset + 1] & 0xFF);
    }

    private void deleteTempDir(Path dir) {
        if (dir == null) return;
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> {
                try { Files.deleteIfExists(p); } catch (IOException ignored) {}
            });
        } catch (IOException ignored) {}
    }
}
