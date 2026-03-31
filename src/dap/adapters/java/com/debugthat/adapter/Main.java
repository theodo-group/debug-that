package com.debugthat.adapter;

import com.microsoft.java.debug.core.adapter.ICompletionsProvider;
import com.microsoft.java.debug.core.adapter.IEvaluationProvider;
import com.microsoft.java.debug.core.adapter.IHotCodeReplaceProvider;
import com.microsoft.java.debug.core.adapter.ISourceLookUpProvider;
import com.microsoft.java.debug.core.adapter.IVirtualMachineManagerProvider;
import com.microsoft.java.debug.core.adapter.ProtocolServer;
import com.microsoft.java.debug.core.adapter.ProviderContext;

import java.io.*;

/**
 * Thin DAP adapter wrapping java-debug.core's ProtocolServer.
 *
 * Reads DAP messages from stdin, writes to stdout.
 * Provides lightweight source lookup and evaluation via JDI.
 */
public class Main {
    public static void main(String[] args) throws Exception {
        InputStream in = System.in;
        OutputStream out = System.out;

        // Redirect System.out to System.err so adapter output doesn't corrupt DAP
        PrintStream stderr = System.err;
        System.setOut(new PrintStream(stderr));

        ProviderContext context = new ProviderContext();
        context.registerProvider(ISourceLookUpProvider.class, new SimpleSourceLookUpProvider());
        context.registerProvider(IEvaluationProvider.class, new CompilingEvaluationProvider());
        context.registerProvider(IHotCodeReplaceProvider.class, new CompilingHotCodeReplaceProvider());
        context.registerProvider(IVirtualMachineManagerProvider.class, new DefaultVirtualMachineManagerProvider());
        context.registerProvider(ICompletionsProvider.class, new NoOpCompletionsProvider());

        ProtocolServer server = new ProtocolServer(in, out, context);
        server.run();
    }
}
