import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

/**
 * A stand-in for kubectl (ADR 0052): it records every command it is given, with what came on stdin, and answers as a
 * cluster with the backup CronJob would. `exec` runs the command on this machine with `/backup` pointed at a fake
 * backup directory, so a pull reads the fake backup exactly as it would read the NFS. Nothing reaches a cluster.
 *
 *   FAKE_KUBECTL_LOG     where the commands are recorded, one JSON line each
 *   FAKE_KUBECTL_BACKUP  the fake backup's directory
 *   FAKE_KUBECTL_FAIL    a verb (`wait`, `apply`…) that fails
 */
const args = process.argv.slice(2);
const stdin = args.includes('-f') && args[args.indexOf('-f') + 1] === '-' ? readFileSync(0, 'utf8') : undefined;
appendFileSync(process.env.FAKE_KUBECTL_LOG!, `${JSON.stringify({ args, ...(stdin === undefined ? {} : { stdin }) })}\n`);

const rest = [...args];
for (const flag of ['--context', '-n', '--namespace']) {
  const index = rest.indexOf(flag);
  if (index >= 0) rest.splice(index, 2);
}
const verb = rest[0];
if (process.env.FAKE_KUBECTL_FAIL === verb) {
  process.stderr.write(`error: fake ${verb} failed\n`);
  process.exit(1);
}
if (verb === 'get') {
  process.stdout.write(JSON.stringify({
    apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name: 'natsumi-backup' },
    spec: { jobTemplate: { spec: { template: { spec: {
      nodeSelector: { 'kubernetes.io/arch': 'amd64' },
      initContainers: [{ name: 'sqlite', image: 'registry.example/natsumi:v0.0.1' }],
      containers: [{ name: 'mirror', image: 'registry.example/sshd:v1' }],
      volumes: [{ name: 'volume', persistentVolumeClaim: { claimName: 'natsumi' } },
        { name: 'backup', nfs: { server: 'nfs.example.invalid', path: '/natsumi' } }],
    } } } } },
  }));
} else if (verb === 'exec') {
  const command = rest.slice(rest.indexOf('--') + 1).map(part => part.replaceAll('/backup', process.env.FAKE_KUBECTL_BACKUP!));
  const result = spawnSync(command[0]!, command.slice(1), { stdio: ['ignore', 'inherit', 'inherit'] });
  process.exit(result.status ?? 1);
} else {
  process.stdout.write(`${verb}: ok\n`);
}
