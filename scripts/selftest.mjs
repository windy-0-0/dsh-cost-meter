#!/usr/bin/env node
/**
 * dsh-cost-meter 脱机自测 —— 只测纯函数，不联网、不读凭据。
 *
 * 覆盖 2026-10-01 定价校准（与 dsh-usage-guard 同批）：
 *   ① 定价表为**官方现行价**（旧价会把金额高估约 1.4~1.9 倍）
 *   ② `isPeakTime` 必须把**法定节假日全天**判为空闲
 *   ③ 「调休上班的周末」官方仍按空闲计 —— 不能按行政调休表算成工作日
 *
 * 校准基准（可复现）：官方 /usage/by_api_key/amount（分时 token）
 *   与 /usage/by_api_key/cost（分时真实扣费）配对拟合，
 *   2026-09-19…10-03 共 15 天（官方总额 ¥225.15）逐日吻合，每天差 <¥0.005。
 *
 * 用法：node scripts/selftest.mjs
 */
import { priceFor, isFreeProvider, isPeakTime } from '../lib/index.js'

let pass = 0
let fail = 0
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '  ✓' : '  ✗ 失败'} ${name}`)
  if (!ok) console.log(`      期望 ${JSON.stringify(want)}  实得 ${JSON.stringify(got)}`)
}

console.log('【① 定价表 = 官方现行价】')
// 官方来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
t('flash：hit [0.02, 0.04]', priceFor('deepseek-flash').hit, [0.02, 0.04])
t('flash：miss [1, 2]', priceFor('deepseek-flash').miss, [1, 2])
t('flash：out [4, 8]', priceFor('deepseek-flash').out, [4, 8])
t('旧名 v4-flash 同档', priceFor('deepseek-v4-flash').miss, [1, 2])
t('旧名 v4-flash-vision-exp 同档', priceFor('deepseek-v4-flash-vision-exp').miss, [1, 2])
t('pro：hit [0.15, 0.30]', priceFor('deepseek-v4-pro').hit, [0.15, 0.3])
t('pro：miss [4.5, 9]', priceFor('deepseek-v4-pro').miss, [4.5, 9])
t('pro：out [13.5, 27]', priceFor('deepseek-v4-pro').out, [13.5, 27])
t('未知模型落 flash 档（不落旧价）', priceFor('some-unknown-model').miss, [1, 2])
t('回归：不得再出现旧价 1.5/3', priceFor('deepseek-flash').miss, [1, 2])
t('回归：不得再出现旧价 4.5/9（flash 档）', priceFor('deepseek-flash').out, [4, 8])

console.log('\n【② 免费通道 / 本机模型计 0 价】')
t('deepseek-web 计 0', priceFor('deepseek-chat', 'deepseek-web'), { hit: [0, 0], miss: [0, 0], out: [0, 0] })
t('本机推理计 0', isFreeProvider('local/llama.cpp'), true)
t('ollama 计 0', isFreeProvider('ollama'), true)
t('付费通道不计 0', isFreeProvider('deepseek-official'), false)

console.log('\n【③ 峰谷判定（⚠ 入参是 Unix 秒，不是毫秒）】')
const bj = (y, m, d, h) => Date.UTC(y, m - 1, d, h - 8, 0, 0) / 1000
t('工作日 09-24（周四）10 点 → 高峰', isPeakTime(bj(2026, 9, 24, 10)), true)
t('工作日 09-24（周四）13 点 → 空闲', isPeakTime(bj(2026, 9, 24, 13)), false)
t('工作日 09-24（周四）15 点 → 高峰', isPeakTime(bj(2026, 9, 24, 15)), true)
t('工作日 09-24（周四）19 点 → 空闲', isPeakTime(bj(2026, 9, 24, 19)), false)
t('普通周六 09-26 10 点 → 空闲', isPeakTime(bj(2026, 9, 26, 10)), false)
t('非法输入 NaN → false', isPeakTime(NaN), false)

console.log('\n【④ 法定节假日全天空闲（2026 表）】')
t('国庆 10-01（周四）10 点 → 空闲', isPeakTime(bj(2026, 10, 1, 10)), false)
t('国庆 10-01（周四）15 点 → 空闲', isPeakTime(bj(2026, 10, 1, 15)), false)
t('国庆末日 10-07（周三）10 点 → 空闲', isPeakTime(bj(2026, 10, 7, 10)), false)
t('春节 02-17（周二）10 点 → 空闲', isPeakTime(bj(2026, 2, 17, 10)), false)
t('劳动节 05-04（周一）15 点 → 空闲', isPeakTime(bj(2026, 5, 4, 15)), false)
t('中秋 09-25（周五）10 点 → 空闲', isPeakTime(bj(2026, 9, 25, 10)), false)
t('节后首个工作日 10-08（周四）10 点 → 高峰', isPeakTime(bj(2026, 10, 8, 10)), true)

console.log('\n【⑤ 调休上班的周末：官方仍按空闲（关键回归）】')
// 2026-09-20 是周日但国务院安排上班。若按工作日算，当天差 ¥12.72（实测）。
t('09-20（周日·调休上班）10 点 → 空闲', isPeakTime(bj(2026, 9, 20, 10)), false)
t('09-20（周日·调休上班）15 点 → 空闲', isPeakTime(bj(2026, 9, 20, 15)), false)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
