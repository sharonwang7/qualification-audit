/**
 * file-lock.js — 跨进程文件锁 + 原子写（F19/C3 修复）
 *
 * 背景：pending_actions.json / audit_reports/*.json 是 cron 批量与手动审核共用的状态文件，
 * 原代码 read-modify-write 全程无锁、且 fs.writeFileSync 非原子 → 两个 agent 并发会丢写、分到同一 n、
 * 或读到半写文件。本模块提供：
 *   - withLock(target, fn)：对 target.lock 做 O_EXCL 互斥，临界区内重读最新再改，杜绝丢写。
 *   - atomicWriteFileSync(target, data)：写同目录临时文件再 rename，杜绝半写文件被并发读到。
 *
 * 注：这是真实运行的 node 工具（非 workflow 脚本），Date.now()/Math.random() 可用。
 */
const fs = require('fs');
const path = require('path');

function _sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) {}
}

/**
 * 以 target 同名 .lock 文件做互斥，在持锁状态下执行 fn 并返回其结果。
 * 拿不到锁则退避重试；超过 timeoutMs 抛错；检测到陈旧锁（持有者崩溃残留）则抢占。
 */
function withLock(targetPath, fn, opts) {
  const lockPath = targetPath + '.lock';
  const timeoutMs = (opts && opts.timeoutMs) || 10000;
  const staleMs = (opts && opts.staleMs) || 30000;
  const start = Date.now();
  let fd = null;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx'); // O_CREAT | O_EXCL
      try { fs.writeSync(fd, String(process.pid)); } catch (e) {}
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 陈旧锁抢占：持有者可能已崩溃
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) { try { fs.unlinkSync(lockPath); } catch (_) {} continue; }
      } catch (_) {}
      if (Date.now() - start > timeoutMs) throw new Error('withLock 获取锁超时: ' + lockPath);
      _sleep(40 + Math.floor(Math.random() * 60));
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(lockPath); } catch (_) {}
  }
}

/** 原子写：写同目录临时文件再 rename（POSIX/Windows 同卷 rename 原子）。 */
function atomicWriteFileSync(targetPath, data, encoding) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.' + path.basename(targetPath) + '.tmp.' + process.pid + '.' + Math.floor(process.hrtime()[1]));
  fs.writeFileSync(tmp, data, encoding || 'utf8');
  try {
    fs.renameSync(tmp, targetPath);
  } catch (e) {
    // Windows 上目标被占用偶发 EPERM/EEXIST：删除目标后重试一次
    try { fs.unlinkSync(targetPath); fs.renameSync(tmp, targetPath); }
    catch (e2) { try { fs.unlinkSync(tmp); } catch (_) {} throw e2; }
  }
}

module.exports = { withLock, atomicWriteFileSync };
