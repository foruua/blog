// 运维脚本的 CLI 参数解析。此前 backup / restore / restore-drill / rotate-logs / seed-comments /
// ui-audit 六处逐字复制同一份 opt()——「改一处忘五处」的高发区，收敛到这里。

/** 解析 argv 为 { argv, has, opt }：has('--x') 判开关，opt('--x') 取值（下一个不以 -- 开头的参数）。 */
export function parseFlags(argv = process.argv.slice(2)) {
  const has = (flag) => argv.includes(flag);
  const opt = (flag, fallback = null) => {
    const i = argv.indexOf(flag);
    // 值不允许以 -- 开头：`--dir --list` 这类漏值会被当成「没给值」走默认，而不是把 --list 吞成路径。
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };
  return { argv, has, opt };
}
