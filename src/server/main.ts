import { homedir } from 'node:os';
import { parseCli, UsageError } from './cli.ts';
import { resolveDataDirectory } from './data-directory.ts';
import { runFoldCommand } from './fold-setting.ts';
import { runModelCommand } from './model-routes.ts';
import { SERVER_UMASK } from './permissions.ts';
import { startServer } from './server.ts';
import { checkHealth, readStatus } from './status.ts';
import { runStatsCommand } from './turn-stats.ts';

// The workspace may run as another UID in a shared group (ADR 0033); see permissions.ts for what stays private.
process.umask(SERVER_UMASK);

try {
  const cli = parseCli(process.argv.slice(2));
  if (cli.command === 'health') {
    const result = checkHealth(await readStatus(await resolveDataDirectory(cli.dataDir, process.cwd())));
    process.stdout.write(`${result.reason}\n`);
    process.exitCode = result.healthy ? 0 : 1;
  } else if (cli.command === 'model') {
    // Reaches a running server through the data directory: it reads the choice before its next turn (ADR 0046).
    process.exitCode = await runModelCommand(cli, await resolveDataDirectory(cli.dataDir, process.cwd()),
      line => { process.stdout.write(`${line}\n`); });
  } else if (cli.command === 'fold') {
    // Like the model route: the server reads the choice before its next turn (ADR 0047).
    process.exitCode = await runFoldCommand(cli, await resolveDataDirectory(cli.dataDir, process.cwd()),
      line => { process.stdout.write(`${line}\n`); });
  } else if (cli.command === 'stats') {
    process.exitCode = await runStatsCommand(cli, await resolveDataDirectory(cli.dataDir, process.cwd()),
      line => { process.stdout.write(`${line}\n`); });
  } else {
    const server = await startServer({
      config: cli.config, dataDir: cli.dataDir, cwd: process.cwd(), home: homedir(), env: process.env,
      log: line => { process.stderr.write(`natsumi: ${line}\n`); },
    });
    // Pi reads its state area from here; the personal default under the home directory is never used.
    process.env.PI_CODING_AGENT_DIR = server.config.pi.agentDirectory;
    const { tls, behindProxy } = server.config.listen;
    const scheme = tls ? 'https' : behindProxy ? 'http (TLS ends at the proxy in front)' : 'http (loopback only)';
    if (server.challengeAddress) {
      const { host, port } = server.challengeAddress;
      process.stdout.write(`natsumi: answering ACME challenges on ${host} port ${port} over http (challenges and redirects only)\n`);
    }
    if (!server.address) process.stdout.write('natsumi: waiting for the ACME certificate before listening\n');
    void server.listening.then(({ host, port }) => {
      process.stdout.write(`natsumi: serving data directory (schema ${server.schemaVersion}); listening on ${host} port ${port} over ${scheme}\n`);
    });
    let signalled = false;
    const onSignal = () => {
      if (signalled) process.exit(1);
      signalled = true;
      server.stop().then(() => process.exit(0), error => { report(error); process.exit(1); });
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }
} catch (error) {
  report(error);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}

function report(error: unknown) {
  process.stderr.write(`natsumi: ${error instanceof Error ? error.message : String(error)}\n`);
}
