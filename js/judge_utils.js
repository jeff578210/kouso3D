// js/judge_utils.js
// 嘴型 / 舌頭判定共用的小工具:數值平滑、短暫失誤寬限。

// 依實際經過時間做平滑(和鏡頭每秒幾張無關):tau 越大越平穩、反應越慢
export function smoothToward(prev, value, dt, tau) {
    return prev + (value - prev) * (1 - Math.exp(-dt / tau));
}

// 辨識結果短暫閃掉(眨眼、光線變化、頭微動)不算中斷動作。
// update() 回傳 'match'(做對)/ 'grace'(剛閃掉,先暫停不扣分)/ 'miss'(確定沒做對)
export function createMatchFilter(graceMs = 250) {
    let lastMatchAt = -Infinity;
    return {
        update(matched, now) {
            if (matched) { lastMatchAt = now; return 'match'; }
            return now - lastMatchAt <= graceMs ? 'grace' : 'miss';
        },
        reset() { lastMatchAt = -Infinity; },
    };
}
