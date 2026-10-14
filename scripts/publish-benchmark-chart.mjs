import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';

/** Publishes a chart on its isolated branch, preserving other runs when concurrent pushes race. */
export function publishBenchmarkChart({ repositoryUrl, chartPath, sourcePath, runnerTemp }) {
    const directory = fs.mkdtempSync(path.join(runnerTemp, 'benchmark-chart-'));
    const git = (...args) => {
        const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
        if (result.error) throw result.error;
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);
        return result.status;
    };
    const checkedGit = (...args) => {
        const status = git(...args);
        if (status !== 0) throw new Error(`git ${args[0]} failed with exit status ${status}`);
    };
    try {
        checkedGit('init', '--initial-branch=benchmark-reports');
        checkedGit('remote', 'add', 'origin', repositoryUrl);
        checkedGit('config', 'credential.helper', '!gh auth git-credential');
        checkedGit('config', 'user.name', 'github-actions[bot]');
        checkedGit('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
        for (let attempt = 1; attempt <= 3; attempt++) {
            const remoteStatus = git('ls-remote', '--exit-code', '--heads', 'origin', 'benchmark-reports');
            if (remoteStatus === 0) {
                checkedGit('fetch', 'origin', 'benchmark-reports');
                checkedGit('switch', '-C', 'benchmark-reports', 'FETCH_HEAD');
            } else if (remoteStatus !== 2) {
                throw new Error(`Could not discover the benchmark chart branch: exit status ${remoteStatus}`);
            }
            const destination = path.join(directory, chartPath);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(sourcePath, destination);
            checkedGit('add', '--', chartPath);
            const diffStatus = git('diff', '--cached', '--quiet');
            if (diffStatus === 1) {
                checkedGit('commit', '-m', `docs: publish benchmark chart ${chartPath}`);
            } else if (diffStatus !== 0) {
                throw new Error(`Could not inspect the benchmark chart changes: exit status ${diffStatus}`);
            }
            if (git('push', 'origin', 'HEAD:refs/heads/benchmark-reports') === 0) return;
            console.log(`Chart publication attempt ${attempt} failed; refreshing the branch.`);
        }
        throw new Error('Could not publish the benchmark chart');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function requiredEnvironment(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    new Command()
        .name('publish-benchmark-chart')
        .description('Publish the workflow chart on the benchmark-reports branch.')
        .action(() =>
            publishBenchmarkChart({
                repositoryUrl: `${requiredEnvironment('GITHUB_SERVER_URL')}/${requiredEnvironment('GITHUB_REPOSITORY')}.git`,
                chartPath: requiredEnvironment('CHART_PATH'),
                sourcePath: requiredEnvironment('BENCHMARK_CHANGE_SVG'),
                runnerTemp: requiredEnvironment('RUNNER_TEMP'),
            }),
        )
        .parse();
}
