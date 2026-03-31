import { $ } from "bun";

// Generate Java adapter sources tarball
await $`tar czf src/dap/adapters/java/adapter-sources.tar.gz -C src/dap/adapters/java com/debugthat/adapter pom.xml`;

// Bundle
await $`bun build src/main.ts --outdir dist --target=bun`;

// Clean up generated tarball
await $`rm src/dap/adapters/java/adapter-sources.tar.gz`;
