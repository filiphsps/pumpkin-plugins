// Pull requests are rebase-merged, so every commit lands on master as written and
// release-please reads each one. Each commit message must be a conventional commit.
export default {
    extends: ['@commitlint/config-conventional'],
    rules: {
        // Long URLs and stack traces in bodies are fine.
        'body-max-line-length': [0],
        'footer-max-line-length': [0]
    }
};
