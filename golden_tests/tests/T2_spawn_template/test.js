// T2_spawn_template/test.js — C01: spawn 模板 && → ;
// 测 spawn prompt 模板中的命令语法在 PS 下是否兼容
// 测试方式：实际跑两种语法，看 exit code

const { execSync } = require('child_process');
const path = require('path');

module.exports = {
  run: async function(ctx) {
    const { assert } = ctx;
    // 包内位置：上 3 级即 skill 根（迁包前为 ../../../skills/qualification-audit）
    const skillDir = path.resolve(__dirname, '../../..');

    // 测试 2.1：`&&` 语法在 PS 下应失败
    {
      try {
        execSync('cd "' + skillDir + '" && node -e "console.log(1+1)"', { shell: 'powershell.exe', encoding: 'utf8', timeout: 5000 });
        assert('T2.1 PS下 && 语法失败', () => { throw new Error('&& 在PS下意外成功'); });
      } catch (e) {
        // 期望它失败
        const hasError = e.stderr ? e.stderr.length > 0 || e.stdout.length === 0 : true;
        const ok = e.code !== 0 || (e.stdout || '').trim() === '';
        if (ok) {
          console.log('    [T2.1] ✓ && 在PS下失败（exit=' + e.code + '），符合预期');
        }
        assert('T2.1 PS下 && 语法失败',
          () => {
            if (!ok) throw new Error('&& 语法意外成功（exit 0）');
          }
        );
      }
    }

    // 测试 2.2：`;` 语法在 PS 下应成功
    {
      try {
        const out = execSync('cd "' + skillDir + '"; node -e "console.log(2)"', { shell: 'powershell.exe', encoding: 'utf8', timeout: 5000 });
        assert('T2.2 PS下 ; 语法成功',
          () => {
            const val = parseInt((out || '').trim(), 10);
            if (val !== 2) throw new Error('预期输出2, 实际=' + out);
            console.log('    [T2.2] ✓ ; 在PS下成功，输出=' + out.trim());
          }
        );
      } catch (e) {
        assert('T2.2 PS下 ; 语法成功', () => { throw new Error('; 语法失败: ' + e.message); });
      }
    }

    return true;
  }
};
