# gen_card_from_json.ps1 — 从结构化 JSON 生成资质审核飞书卡片
# 用法: powershell -File gen_card_from_json.ps1 [-Date YYYYMMDD] [-ChatId oc_xxx] [-Round N]
# 不传 Date：自动从 pending_actions.json 里找 PENDING_REVIEW 案件的 date 字段，定位正确报告文件；
# 显式传 Date：强制读该日期文件（历史复盘用）。
# 本文件自包含——所有依赖已内联，不依赖外部 feishu-common.ps1。

param(
    [string]$Date      = '',
    [string]$ChatId    = $env:LARK_AUDIT_CHAT_ID,
    [int]$Round        = 1,
    [int]$Remaining    = 0,
    [string]$UpdateMessageId = '',
    [string]$Category  = ''    # 拆卡：'A'(法人+其他)/'B'(商标+授权)；空=全部(单卡现状)
)

# ═══════════ 自包含：飞书 API 助手函数（原 feishu-common.ps1，已内联）═══════════

function Get-FeishuAccountCred {
    param([Parameter(Mandatory = $true)][string]$Account)
    $statePath = Join-Path $env:APPDATA 'FanDo\openclaw\openclaw.json'
    if (-not (Test-Path $statePath)) { throw "openclaw.json not found at $statePath" }
    $cfg = [System.IO.File]::ReadAllText($statePath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $a = $cfg.channels.feishu.accounts.$Account
    if (-not $a) { throw "Feishu account not found in openclaw.json: $Account" }
    [PSCustomObject]@{ app_id = [string]$a.appId; app_secret = [string]$a.appSecret }
}

function Get-FeishuTokenFor {
    param([string]$AppId, [string]$AppSecret)
    $body = @{ app_id = $AppId; app_secret = $AppSecret } | ConvertTo-Json -Compress
    $resp = Invoke-RestMethod -Method Post -Uri 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 20
    if ($resp.code -ne 0) { throw "Feishu token error: $($resp.code) $($resp.msg)" }
    $resp.tenant_access_token
}

function Invoke-FeishuApi {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Uri,
        $Body = $null,
        [string]$Token
    )
    if (-not $Token) { throw "Token required for Invoke-FeishuApi" }
    $headers = @{ Authorization = "Bearer $Token" }
    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 10 -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $resp = Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $bytes
    }
    else {
        $resp = Invoke-RestMethod -Method $Method -Uri $Uri -Headers $headers
    }
    if ($resp.code -ne 0) { throw "Feishu API error ($Uri): $($resp.code) $($resp.msg)" }
    $resp
}

# ═══════════ 主逻辑 ═══════════

# ── Profile-aware 兜底（2026-07-10）：手动直接跑本 ps1（没走 `audit-tool gen-card`，因而没被工具设 env）时，──
#   按 QUAL_PROFILE=test 自动兜底 test 的 pending/报告目录 + zizhi 身份，避免：①读到【生产】pending_actions/报告 → 筛不到 test 案件 → 空卡；②没设身份 → 落到 claude_bot(大公子) 发卡。
#   走 audit-tool gen-card 时这些 env 已被工具设好，本段是 no-op；prod 手动跑用其自身默认(生产路径+claude_bot=大公子)，不受影响。
if ($env:QUAL_PROFILE -eq 'test') {
    if (-not $env:QUAL_PENDING_ACTIONS) { $env:QUAL_PENDING_ACTIONS = "$PSScriptRoot\..\..\_test\pending_actions.test.json" }
    if (-not $env:QUAL_AUDIT_DIR)        { $env:QUAL_AUDIT_DIR = "$PSScriptRoot\..\..\_test\audit_reports" }
    if (-not $env:QUAL_CARD_BOT_ACCOUNT) { $env:QUAL_CARD_BOT_ACCOUNT = 'zizhi' }
    if (-not $env:LARK_AUDIT_CHAT_ID)    { $env:LARK_AUDIT_CHAT_ID = 'oc_e8198717e2b926d97fb9007171aef2af' }
    if (-not $ChatId)                    { $ChatId = 'oc_e8198717e2b926d97fb9007171aef2af' }
}

# 资质 → 卡片类别（与 audit-tool.cjs categorize 保持一致）。$stored 为报告里已盖的 category，优先用。
function categorizeSeal($sealType, $stored) {
    if ($stored) { return [string]$stored }
    $s = [string]$sealType
    if ($s -match '法定代表人|法人|董事|股东') { return 'A' }
    if ($s -match '商标注册证|商标授权书|品牌授权书|授权书') { return 'B' }
    return 'A'
}
if (-not $ChatId) { $ChatId = "oc_3b0f48c1c9809c32e3749788da412078" }
$AuditDir = if ($env:QUAL_AUDIT_DIR) { $env:QUAL_AUDIT_DIR } else { "$PSScriptRoot\..\..\audit_reports" }

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# ── 加载 pending_actions（pa）──
$paPath = if ($env:QUAL_PENDING_ACTIONS) { $env:QUAL_PENDING_ACTIONS } else { "$PSScriptRoot\..\..\pending_actions.json" }
$pa = $null
if (Test-Path $paPath) {
    try { $pa = [System.IO.File]::ReadAllText($paPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json } catch {}
}
# fail-loud（2026-07-30 王爷定）：prod 下 pending 读不到($pa=null) → 下面的过滤会【全放行】把已 CLOSED 件也上卡。
#   宁可拒发也绝不发一张【未按 CLOSED 过滤】的卡（直堵"pa=null→全放行"这个洞）。
if ($env:QUAL_PROFILE -eq 'prod' -and $null -eq $pa) {
    Write-Error "gen-card 拒发：QUAL_PROFILE=prod 但 pending_actions 读取为空/失败（paPath=$paPath）→ 无法按 CLOSED/everClosed 过滤，会把已审结件误上卡。请确认 QUAL_PENDING_ACTIONS 指向正确的生产 pending 后重跑。"
    exit 1
}

# ── ⑥ 跨批次聚合：从 pa 收集所有应出卡状态（PENDING_REVIEW / APPLICANT_REPLIED）的批次日期 ──
# 解决"7/3 分析、7/4 发卡只读今天"的问题；多批次均有待处理案件时全量合并。
# 显式 -Date：强制单文件（历史复盘）。
# date 卫戍（2026-07-25 王爷事故·治 "gen-card 1 \"\" 0" 空卡）：非法 -Date（"0"、被 shell 吞掉空串后错位、非 8 位 yyyyMMdd）
#   当作"无日期" → 走下面的多批次聚合(读今日 + pending 批次)，绝不去读 0.json 等不存在的文件 → 空卡。
if ($Date -and $Date -notmatch '^\d{8}$') { Write-Host "gen_card: 非法 -Date '$Date' → 忽略，按多批次聚合渲染"; $Date = $null }
$SHOW_STATES = @('PENDING_REVIEW', 'APPLICANT_REPLIED')
$targetDates = @()
if (-not $Date) {
    if ($null -ne $pa) {
        $targetDates = @($pa.PSObject.Properties |
            Where-Object { $_.Name -ne '__meta' -and $SHOW_STATES -contains $_.Value.state -and $_.Value.date } |
            ForEach-Object { $_.Value.date } |
            Select-Object -Unique |
            Sort-Object -Descending)
    }
    # 安全网：今天的文件也纳入（覆盖"pa条目缺失但report存在"的极端情况）
    $today = Get-Date -Format 'yyyyMMdd'
    $todayFile = Join-Path $AuditDir "${today}.json"
    if ((Test-Path $todayFile) -and ($targetDates -notcontains $today)) {
        $targetDates = @($targetDates) + @($today) | Sort-Object -Descending
    }
}

# ── 读取并合并报告文件 ──
# 🔴 PS5.1 折叠 bug：@(管道|ConvertFrom-Json) 把数组折成1条 → 先落变量再 @()
$allCases = @()
$seen = @{}
if ($Date) {
    # 显式指定日期，单文件模式
    $p = Join-Path $AuditDir "${Date}.json"
    if (Test-Path $p) {
        $raw = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        $allCases = @($raw)
    }
} elseif ($targetDates.Count -gt 0) {
    # 多批次合并：最近日期优先，按 instanceCode 去重（同一件只取最新版本）
    foreach ($d in $targetDates) {
        $p = Join-Path $AuditDir "${d}.json"
        if (-not (Test-Path $p)) { continue }
        try {
            $batchRaw = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            foreach ($c in @($batchRaw)) {
                $code = $c.instanceCode
                if ($code -and -not $seen.ContainsKey($code)) {
                    $seen[$code] = $true
                    $allCases += $c
                }
            }
        } catch {}
    }
    $Date = $targetDates[0]  # 用最近日期显示卡片标题
} else {
    # 无待出卡案件，退到今天（兜底）
    $Date = Get-Date -Format 'yyyyMMdd'
    $p = Join-Path $AuditDir "${Date}.json"
    if (Test-Path $p) {
        $raw = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        $allCases = @($raw)
    }
}

# 过滤逻辑：CLOSED / AWAITING_APPLICANT 跳过；PENDING_REVIEW 保留（需 F/A/I/R 确认）；其余保留
# （2026-07-02）AWAITING_APPLICANT=已留言等申请人补材料，球在申请人侧，不该反复推给审批人上卡。
$cases = @($allCases | Where-Object {
    $code = $_.instanceCode
    if ($pa -and $pa.$code) {
        $state = $pa.$code.state
        # everClosed 持久闸（2026-07-30）：审核过的件永不再上卡，即使 state 被漂移回 open。
        if ($state -eq 'CLOSED' -or $state -eq 'AWAITING_APPLICANT' -or $pa.$code.everClosed -eq $true) { return $false }
    }
    return $true
})
$skipped = $allCases.Count - $cases.Count
if ($skipped -gt 0) { Write-Host "已跳过 ${skipped} 条 CLOSED/AWAITING_APPLICANT case" }

# 拆卡过滤：$Category='A'/'B' 时只保留该类；空 → 全部（单卡现状）。fallback 分类兼容无 category 的旧案。
if ($Category) {
    $cases = @($cases | Where-Object { (categorizeSeal $_.sealType $_.category) -eq $Category })
    Write-Host "类别过滤 Category=$Category → 保留 $($cases.Count) 条"
}

# ── 空卡防抖闸（2026-07-25 王爷事故·治瞬态空卡）：$cases=0 但 pending 明明有 PENDING_REVIEW 待确认件 →
#    台账读取瞬态出错(读到0，非真无件)。重读一次台账；仍0则【拒发空卡】(exit1)，绝不发"本批共0条"糊弄用户。
if ($cases.Count -eq 0 -and $pa) {
    $expectReview = @($pa.PSObject.Properties | Where-Object { $_.Name -ne '__meta' -and $_.Value.state -eq 'PENDING_REVIEW' }).Count
    if ($expectReview -gt 0) {
        Write-Host "空卡防抖：cases=0 但 pending 有 ${expectReview} 件待确认 → 重读台账"
        Start-Sleep -Milliseconds 400
        $allCases2 = @(); $seen2 = @{}
        foreach ($d in $targetDates) {
            $p2 = Join-Path $AuditDir "${d}.json"
            if (-not (Test-Path $p2)) { continue }
            try { $raw2 = [System.IO.File]::ReadAllText($p2, [System.Text.Encoding]::UTF8) | ConvertFrom-Json; foreach ($c2 in @($raw2)) { if ($c2.instanceCode -and -not $seen2.ContainsKey($c2.instanceCode)) { $seen2[$c2.instanceCode] = $true; $allCases2 += $c2 } } } catch {}
        }
        $cases = @($allCases2 | Where-Object { $code = $_.instanceCode; if ($pa -and $pa.$code) { $st = $pa.$code.state; if ($st -eq 'CLOSED' -or $st -eq 'AWAITING_APPLICANT' -or $pa.$code.everClosed -eq $true) { return $false } }; return $true })
        if ($Category) { $cases = @($cases | Where-Object { (categorizeSeal $_.sealType $_.category) -eq $Category }) }
        Write-Host "空卡防抖：重读后 cases=$($cases.Count)"
        if ($cases.Count -eq 0) {
            Write-Error "空卡防抖闸：pending 有 ${expectReview} 件 PENDING_REVIEW，台账两次读取都得 0 条 → 疑似文件竞态/瞬态读空，【拒发空卡】。请重跑 gen-card。"
            exit 1
        }
    }
}

# ── 裁决值归一化（兼容中/英文）──
function normalizeVerdict($v) {
    if ([string]::IsNullOrWhiteSpace($v)) { return '' }
    $s = ([string]$v).Trim()
    # 英文枚举兜底：agent 偶尔写 APPROVE/PASS/SUPPLEMENT 等，须归一到中文，否则汇总计 0、卡片裸奔。
    switch -Regex ($s.ToUpper()) {
        '^(PASS|PASSED|APPROVE|APPROVED|OK)$'          { return '通过' }
        '^(SUPPLEMENT|NEED.?SUPPLEMENT|NEEDS?.?INFO)$' { return '需补充' }
        '^(REJECT|REJECTED|DENY|DENIED|FAIL)$'         { return '退回' }
        '^(HUMAN|MANUAL|ESCALATE)$'                    { return '转人工' }
        default                                        { return $s }  # 中文 verdict 原样返回
    }
}

# 分组：先归一化 verdict
$pass   = @($cases | Where-Object { (normalizeVerdict $_.verdict) -eq '通过' })
$reject = @($cases | Where-Object { (normalizeVerdict $_.verdict) -eq '退回' })
$review = @($cases | Where-Object { (normalizeVerdict $_.verdict) -eq '需补充' })
$human  = @($cases | Where-Object { (normalizeVerdict $_.verdict) -eq '转人工' })

function verdictIcon($v) {
    $n = normalizeVerdict $v
    switch ($n) {
        '通过'   { return '✅' }
        '退回'   { return '❌' }
        '需补充' { return '⚠️' }
        '转人工' { return '🔴' }
        default  { return '❓' }
    }
}

# 飞书卡片 markdown：保留源换行结构——单 `n = 紧凑换行（bullet/①②③/连续行不空行）、空行(`n`n) = 段落分隔。
# 只做两件事：① 拆开 run-on 里贴在一起的小节标记(阶段一/二/三/四、①-⑤、# 标题)；② 折叠 3+ 连续换行为最多 2、去每行行尾空白。
# 2026-07-06 复原：此前"逐行一律 `n`n"把连续 bullet/①②③/紧凑行全拉开空行；而 07-02 满意卡是【保留单 `n】的旧版渲染的
#   —— Feishu 卡片对单 `n 本就渲染成紧凑换行（非"软换行不渲染"）。故复原为"保留源结构"，只在源里本就有空行处分段。
function toFeishuMd($t) {
    if ([string]::IsNullOrEmpty($t)) { return $t }
    $s = $t -replace "`r`n", "`n" -replace "`r", "`n"
    # 拆开粘连的小节标记（前一字符是非空白【且非 markdown 语法符 *】才拆；
    # 排除 * 防止 **阶段一**/**①** 这类粗体标题的前导 ** 被换行切开→加粗配对断裂、** 字面漏出。对齐下方 # 标题的 [^\s#] 做法）
    # 2026-07-30(B1)：lookbehind 额外排除开括号【「（( —— 否则「【阶段一·xxx】」里 阶段一 前是 【，会被切成「【\n阶段一…」孤立 【（zizhi 实跑 #78 卡片实证）。
    $s = [regex]::Replace($s, '(?<=[^\s*【「（(])(阶段[一二三四])', "`n`$1")
    $s = [regex]::Replace($s, '(?<=[^\s*【「（(])([①②③④⑤])', "`n`$1")
    # # 标题：lookbehind 排除前一字符是 #，否则正常「## 标题」会被拆成「#\n# 标题」（孤 #）；仍能拆真 run-on（# 前是汉字）。
    $s = [regex]::Replace($s, '(?<=[^\s#])(#{1,4}\s)', "`n`$1")
    # 去每行行尾空白，保留源的单/双换行结构
    $s = (($s -split "`n") | ForEach-Object { $_.TrimEnd() }) -join "`n"
    # 折叠 3+ 连续换行为最多一个空行（段落上限），并去首尾空白
    $s = [regex]::Replace($s, "`n{3,}", "`n`n")
    $s.Trim()
}

function buildCaseBlock($c) {
    $applink = "https://applink.feishu.cn/client/mini_program/open?appId=cli_9cb844403dbb9108&mode=appCenter&path_pc=pc/pages/in-process/index?instanceId=$($c.instanceCode)&source=bitable&path=pages/detail/index?instanceId=$($c.instanceCode)&source=bitable"
    $icon = verdictIcon $c.verdict
    $waitLabel = ""
    if ($c.createTime) {
        $nowSec = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $ct = if ($c.createTime -is [array]) { [long]($c.createTime[0]) } else { [long]$c.createTime }
        $waitDays = [Math]::Floor(($nowSec - $ct) / 86400)
        if ($waitDays -ge 7) { $waitLabel = "  🚨 已等待 ${waitDays} 天" }
        elseif ($waitDays -ge 1) { $waitLabel = "  ⏳ 已等待 ${waitDays} 天" }
    }
    # 字段兜底：真实流程 result.json 可能用 applicant / 缺字段（agent schema 不规范），回退 + 占位，避免卡头裸奔。
    $person   = if ($c.person)   { $c.person }   elseif ($c.applicant) { $c.applicant } else { '⚠️申请人缺失' }
    $sealType = if ($c.sealType) { $c.sealType } elseif ($c.seal_type) { $c.seal_type } else { '⚠️资质类型缺失' }
    $entity   = if ($c.entity)   { $c.entity }   elseif ($c.company)   { $c.company }   else { '⚠️主体缺失' }
    $dest     = if ($c.dest)     { $c.dest }     else { '⚠️流向缺失' }
    $header = "**#$($c.n) $person — $sealType**${waitLabel}"
    $meta   = "$entity → $dest"
    $ctx    = if ($c.context) { "> $($c.context)" } else { "> （事由缺失）" }

    # 逐段拼好后统一过 toFeishuMd：飞书卡片单个 `n 不分行，必须转成空行(`n`n)。
    $parts = @($header, $meta, $ctx, $c.fullAnalysis)
    if ($c.suggestion) { $parts += "**建议**：$($c.suggestion)" }
    $parts += "$icon **结论：$(normalizeVerdict $c.verdict)**  [$person 的审批链接]($applink)"
    $body = toFeishuMd ($parts -join "`n")

    return @(
        @{ tag = 'markdown'; content = $body },
        @{ tag = 'hr' }
    )
}

# ── 收集 PENDING_REVIEW 案例用于 banner ──
$pendingReviewItems = @()
# 拆卡时 banner 只列本类的 #N（按当前 $cases 的 n 集合过滤；pa 无 category 字段，故用 n 交集）
$catNs = @($cases | ForEach-Object { [int]$_.n })
if ($pa) {
    foreach ($prop in $pa.PSObject.Properties) {
        if ($prop.Name -eq '__meta') { continue }
        if ($prop.Value.state -eq 'PENDING_REVIEW') {
            if ($Category -and ($catNs -notcontains [int]$prop.Value.n)) { continue }
            $pendingReviewItems += "#$($prop.Value.n) $($prop.Value.person)（$($prop.Value.verdict)）"
        }
    }
}

# ── 构造卡片元素 ──
$elements = @()

# ── 快捷处理（2026-07-09）：卡片最前面列好【填好编号、可直接复制】的 FAIR 指令，按结论分组 ──
# 通过=一条 F# 带全部编号（批量放行）；需补充=逐个 I#（各需补要求）；退回=逐个 A#（各需原因）。
# 用单引号字面量拼接反引号（markdown 行内代码，便于选中复制），避开 PS 双引号里反引号=转义符、及嵌套双引号的坑。
$passNs   = @($pass   | Sort-Object { [int]$_.n } | ForEach-Object { $_.n })
$reviewNs = @($review | Sort-Object { [int]$_.n } | ForEach-Object { $_.n })
$rejectNs = @($reject | Sort-Object { [int]$_.n } | ForEach-Object { $_.n })
$fairLines = @()
if ($passNs.Count -gt 0)   { $fairLines += '通过：'   + (($passNs   | ForEach-Object { 'F#' + $_ }) -join ' ') }
if ($reviewNs.Count -gt 0) { $fairLines += '待补充：' + (($reviewNs | ForEach-Object { 'I#' + $_ }) -join ' ') }
if ($rejectNs.Count -gt 0) { $fairLines += '退回：'   + (($rejectNs | ForEach-Object { 'A#' + $_ }) -join ' ') }
if ($fairLines.Count -gt 0) {
    $fairBody = $fairLines -join "`n"
    $elements += @{ tag = 'markdown'; content = "🎯 **一键复制**`n$fairBody" }
    $elements += @{ tag = 'hr' }
}

# PENDING_REVIEW banner（有待确认案例时显示）
if ($pendingReviewItems.Count -gt 0) {
    $prList = $pendingReviewItems -join "  |  "
    $elements += @{ tag = 'markdown'; content = "⏸️ **等待你确认（PENDING_REVIEW）**：$prList" }
    $elements += @{ tag = 'hr' }
}

# ── 未审结·待人工 banner（2026-07-09 P1，防静默漏审）：读 current_batch.json outcomes 里 status=timeout 的件，显式列出 ──
# 这些件因子代理超时未审结、无结论、不进下方分组；台账保留、下轮 list 自动重captured 重审。绝不给假 verdict、绝不静默省略。
$timeoutCodes = @()
$cbPath = Join-Path $AuditDir 'current_batch.json'
if (Test-Path $cbPath) {
    try {
        $cb = [System.IO.File]::ReadAllText($cbPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($cb.outcomes) {
            foreach ($p in $cb.outcomes.PSObject.Properties) {
                if ($p.Value.status -eq 'timeout' -or $p.Value.status -eq 'failed') { $timeoutCodes += [string]$p.Name }
            }
        }
    } catch {}
}
if ($timeoutCodes.Count -gt 0) {
    $tShort = ($timeoutCodes | ForEach-Object { $_.Substring(0, [Math]::Min(8, $_.Length)) }) -join ', '
    $elements += @{ tag = 'markdown'; content = "⚠️ **本轮有 $($timeoutCodes.Count) 件因子代理超时/失败未审结**（未列入下方结论，需人工复核）：$tShort`n已保留台账、下轮自动重审；若反复超时/失败请人工复核原件。" }
    $elements += @{ tag = 'hr' }
}

# 汇总行
$summary = "**本批共 $($cases.Count) 条**：✅ 建议通过 $($pass.Count) 条  |  ❌ 退回 $($reject.Count) 条  |  ⚠️ 需补充 $($review.Count) 条  |  🔴 转人工 $($human.Count) 条"
if ($Remaining -gt 0) { $summary += "`n`n⏭️ 另有 **$Remaining 条**待下轮审核（已自动排队，不会遗漏）" }
$elements += @{ tag = 'markdown'; content = $summary }

# ── 链式卡 footer（2026-07-28）：diff 摘要 + 前轮跳转链接 ──
$chainFooter = ""
$diffSummary = $env:QUAL_DIFF_SUMMARY
if ($diffSummary) { $chainFooter += "📊 $diffSummary" }
$prevMsgId = $env:QUAL_PREV_MSG_ID
if ($prevMsgId -and $diffSummary) {
  $chainFooter += "  |  "
}
if ($prevMsgId) {
  # 前轮卡跳转（飞书同群消息链接）
  $chainFooter += "📋 [← 上一轮](https://open.feishu.cn/open-apis/im/v1/messages/${prevMsgId}/uri?domain=Feishu)"
}
if ($chainFooter) { $elements += @{ tag = 'markdown'; content = $chainFooter } }
$elements += @{ tag = 'hr' }


# 扁平渲染：按 n 升序（gen-card 已把 n 按提交时间重排 → 等待最久在前）。
# 结论分布见上方汇总行；每条自身 buildCaseBlock 里也带结论图标+文字，不再按 verdict 分组。
$ordered = @($cases | Sort-Object { [int]$_.n })
foreach ($c in $ordered) {
    $elements += buildCaseBlock $c
}

# 操作指引（末尾固定）
$elements += @{ tag = 'hr' }
$elements += @{
    tag = 'markdown'
    content = "━━━ 操作指引 FAIRS ━━━`n`n**F#编号** 通过　　**A#编号** 退回　　**I#编号** 留言补充　　**R#编号 原因** 修订重新分析`n`n*S#编号  越界踢出（该件不属我方管辖，内部关闭，申请人无感知）*"
}

# ── 构造卡片 ──
# 防御（2026-07-09 三公子发现）：$Date 必须是 8 位 yyyyMMdd，否则下方 .Substring(0,4/4,2/6,2) 抛错。非法则回退今天。
if (-not $Date -or $Date.Length -lt 8) { $Date = Get-Date -Format 'yyyyMMdd' }
$card = @{
    schema = '2.0'
    config = @{
        wide_screen_mode = $true
        enable_forward = $false
    }
    header = @{
        template = $(switch ($Category) { 'B' { 'turquoise' } default { 'blue' } })
        title = @{ tag = 'plain_text'; content = "资质审核报告$(switch ($Category) { 'A' { ' · 法人+其他' } 'B' { ' · 商标+授权' } default { '' } }) · $($Date.Substring(0,4))-$($Date.Substring(4,2))-$($Date.Substring(6,2)) 第 ${Round} 轮 🆕" }
    }
    body = @{ elements = $elements }
}

$cardJson = $card | ConvertTo-Json -Depth 20 -Compress

# 写到临时文件检查大小
$tmpCard = "C:\Users\FD\AppData\Local\Temp\qual_card.json"
[System.IO.File]::WriteAllText($tmpCard, $cardJson, [System.Text.Encoding]::UTF8)
$sizeKb = [Math]::Round((Get-Item $tmpCard).Length / 1024, 1)
Write-Host "卡片大小: ${sizeKb}KB"

# ── 发送 / 更新卡片 ──
# 发卡身份（2026-07-09 修 #3）：QUAL_CARD_BOT_ACCOUNT 指定 feishu account key（如 test=zizhi=资质审核助手）→
# 用该 bot 自己的 app 令牌发/更新卡；不设 → 回退默认 claude_bot(大公子)，生产维持现状。
$cardBotAccount = $env:QUAL_CARD_BOT_ACCOUNT
if ($cardBotAccount) {
    $cbCred = Get-FeishuAccountCred $cardBotAccount
    $token = Get-FeishuTokenFor $cbCred.app_id $cbCred.app_secret
    Write-Host "发卡身份: account=$cardBotAccount (appId=$($cbCred.app_id))"
} else {
    $token = Get-FeishuTenantToken
    Write-Host "发卡身份: 默认 claude_bot"
}
if ($UpdateMessageId) {
    # Q1a: update 模式——patch 已有卡片，不重发
    $body = @{ content = $cardJson }
    $resp = Invoke-FeishuApi -Method Patch -Uri "https://open.feishu.cn/open-apis/im/v1/messages/$($UpdateMessageId)" -Body $body -Token $token
    Write-Host ($resp | ConvertTo-Json -Compress)
} else {
    $body = @{ receive_id = $ChatId; msg_type = 'interactive'; content = $cardJson }
    $resp = Invoke-FeishuApi -Method Post -Uri "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id" -Body $body -Token $token
    Write-Host ($resp | ConvertTo-Json -Compress)
}
