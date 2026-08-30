import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/**/*.spec.ts'],
        // Default environment is node, which is what the pure modules want. The
        // DOM specs opt in per file with a `@vitest-environment jsdom` docblock,
        // so a jsdom window is never present in a test that should not need one.
        environment: 'node',
        // A stray `it.only` would otherwise produce a confident green over a
        // fraction of the suite. Vitest's default for this is `!process.env.CI`,
        // which means "permissive on every laptop".
        allowOnly: false,
    },
});
