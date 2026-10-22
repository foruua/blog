import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-deploy-test-'));
try {
  for (const failure of ['backup', 'copy', 'backfill', 'health', 'restore', 'none']) {
    const base = path.join(root, failure), app = path.join(base, 'app'), release = path.join(base, 'release'), mocks = path.join(base, 'bin');
    for (const dir of [app, release + '/next', mocks, app + '/state', app + '/node_modules', release + '/next/node_modules']) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(app + '/version', 'old'); fs.writeFileSync(app + '/retired', 'old only');
    fs.writeFileSync(app + '/node_modules/pkg', 'old dependency');
    fs.writeFileSync(release + '/next/version', 'new'); fs.writeFileSync(release + '/next/node_modules/pkg', 'new dependency');
    fs.writeFileSync(app + '/state/content', 'persistent'); fs.writeFileSync(app + '/.env', 'private');
    fs.symlinkSync('state', app + '/data'); fs.symlinkSync('state', app + '/content');
    const writeMock = (name, body) => fs.writeFileSync(path.join(mocks, name), '#!/bin/bash\nset -eu\n' + body, { mode: 0o755 });
    writeMock('flock', 'exit 0\n'); // macOS 无 flock；这里只模拟命令，不操作系统服务。
    writeMock('systemctl', 'echo "$*" >> "$TEST_BASE/service-log"\n');
    writeMock('runuser', `case "$*" in
      *backup.mjs*) test "$FAILURE" != backup ;;
      *backfill-media.mjs*) test "$FAILURE" != backfill ;;
      *restore-drill.mjs*) test "$FAILURE" != restore ;;
    esac\n`);
    writeMock('curl', 'if test "$FAILURE" = health && test "$(cat "$BLOG_DEPLOY_APP_ROOT/version")" = new; then exit 22; fi\n');
    writeMock('rsync', `if test "$FAILURE" = copy && [[ "$*" = *'/next/'* ]] && ! test -f "$TEST_BASE/copy-failed"; then
      touch "$TEST_BASE/copy-failed"; echo partial > "$BLOG_DEPLOY_APP_ROOT/version"; exit 23
    fi
    exec /usr/bin/rsync "$@"\n`);
    const env = { ...process.env, PATH: mocks + ':' + process.env.PATH, TEST_BASE: base, FAILURE: failure, BLOG_DEPLOY_APP_ROOT: app };
    const run = (mode) => spawnSync('bash', ['scripts/deploy-release.sh', mode, release], { env, encoding: 'utf8' });
    const activated = run('activate');
    assert.equal(activated.status === 0, failure === 'none', activated.stderr);
    if (failure === 'none') {
      assert.equal(fs.readFileSync(app + '/version', 'utf8'), 'new');
      assert.equal(fs.readFileSync(app + '/node_modules/pkg', 'utf8'), 'new dependency');
      assert.ok(!fs.existsSync(app + '/retired'));
      assert.notEqual(run('activate').status, 0); // 未完成验证时拒绝其他激活。
      const other = spawnSync('bash', ['scripts/deploy-release.sh', 'rollback', release + '-other'], { env, encoding: 'utf8' });
      assert.notEqual(other.status, 0);
      assert.equal(fs.readFileSync(app + '/version', 'utf8'), 'new');
      assert.equal(run('rollback').status, 0);    }
    assert.equal(fs.readFileSync(app + '/version', 'utf8'), 'old');
    assert.equal(fs.readFileSync(app + '/node_modules/pkg', 'utf8'), 'old dependency');
    assert.equal(fs.readFileSync(app + '/state/content', 'utf8'), 'persistent');
    assert.equal(fs.readFileSync(app + '/.env', 'utf8'), 'private');
    assert.equal(fs.readlinkSync(app + '/data'), 'state');
    assert.equal(fs.readlinkSync(app + '/content'), 'state');
    assert.equal(run('rollback').status, 0);    assert.ok(fs.readFileSync(base + '/service-log', 'utf8').trim().endsWith('start blog'));
    if (failure === 'none') {
      assert.equal(run('activate').status, 0);
      assert.equal(run('commit').status, 0);
      assert.equal(run('rollback').status, 0);
      assert.equal(fs.readFileSync(app + '/version', 'utf8'), 'new');
    }
    console.log(`✓ 部署 ${failure}：版本与依赖恢复，数据/配置/链接保留`);
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
