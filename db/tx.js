// 唯一的事务原语。用 SAVEPOINT 而非 BEGIN：写路径会嵌套事务（syncContent 的大事务里每篇文件又走
// upsertFromFile 自己的事务等），SQLite 不许嵌套 BEGIN，SAVEPOINT 可任意嵌套、最外层等价 BEGIN。
// repo/feeds 曾各用一套，包起来才炸。prefix 只让 savepoint 名字可读。
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export function createTx(db, prefix = 'tx') {
  let sequence = 0;
  return (fn) => {
    // 必须在执行前拒绝：如果先 fn() 再发现是 async，await 之后的写入已经在事务外，
    // 会绕过 ROLLBACK 继续落库。后面的 thenable 检查仍保留，用于兜住返回 Promise 的普通函数。
    if (fn instanceof AsyncFunction) throw new Error('事务回调不能是 async：同步事务无法等待 Promise，提交会早于异步写入');
    const savepoint = `${prefix}_${++sequence}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        throw new Error('事务回调不能是 async：同步事务无法等待 Promise，提交会早于异步写入');
      }
      db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      // ROLLBACK 本身也可能因 IOERR/FULL 失败；不能让它替换掉真正的业务错误，但要留下可排查的记录。
      try { db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); }
      catch (rollbackError) {
        console.error(JSON.stringify({ event: 'tx.rollback-failed', savepoint, code: rollbackError?.code ?? 'INTERNAL' }));
      }
      throw error;
    }
  };
}
