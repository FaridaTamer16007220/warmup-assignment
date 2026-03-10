const fs = require("fs");

// --- Time parsing and formatting helpers ---
function parseTimeToSeconds(timeStr) {
    if (!timeStr || typeof timeStr !== "string") return 0;
    const s = timeStr.trim();
    const match = s.match(/^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*:\s*(\d{1,2})\s*(am|pm)\s*$/i);
    if (!match) return 0;
    let h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const sec = parseInt(match[3], 10);
    const ampm = (match[4] || "").toLowerCase();
    if (ampm === "pm" && h !== 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    return h * 3600 + m * 60 + sec;
}

function parseDurationToSeconds(durStr) {
    if (!durStr || typeof durStr !== "string") return 0;
    const parts = durStr.trim().split(":").map(p => parseInt(p.trim(), 10));
    if (parts.length < 3 || parts.some(n => isNaN(n))) return 0;
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function secondsToHMMSS(totalSeconds) {
    if (isNaN(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

// Format as hhh:mm:ss (hours with no leading zero, e.g. "33:30:00", "26:48:00")
function secondsToHHHMMSS(totalSeconds) {
    if (isNaN(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

// =========================================================
// Function 1: getShiftDuration(startTime, endTime)
// ============================================================
function getShiftDuration(startTime, endTime) {
    const start = parseTimeToSeconds(startTime);
    const end = parseTimeToSeconds(endTime);
    let diff = end - start;
    if (diff < 0) diff += 24 * 3600;
    return secondsToHMMSS(diff);
}

// Delivery window: 8:00 AM - 10:00 PM (inclusive). Time outside = idle.
const DELIVERY_START_SEC = 8 * 3600;   // 8:00 AM
const DELIVERY_END_SEC = 22 * 3600;   // 10:00 PM

// ============================================================
// Function 2: getIdleTime(startTime, endTime)
// Idle = time before 8 AM + time after 10 PM within the shift.
// ============================================================
function getIdleTime(startTime, endTime) {
    const start = parseTimeToSeconds(startTime);
    const end = parseTimeToSeconds(endTime);
    let endAdj = end;
    if (endAdj < start) endAdj += 24 * 3600; // handle shift crossing midnight

    const shiftSec = endAdj - start;
    if (shiftSec <= 0) return "0:00:00";

    // Active delivery time is the overlap with delivery windows (8:00–22:00) for each day spanned.
    let activeWithinWindow = 0;
    const firstDay = Math.floor(start / (24 * 3600));
    const lastDay = Math.floor(endAdj / (24 * 3600));
    for (let day = firstDay; day <= lastDay; day++) {
        const windowStart = day * 24 * 3600 + DELIVERY_START_SEC;
        const windowEnd = day * 24 * 3600 + DELIVERY_END_SEC;
        const overlapStart = Math.max(start, windowStart);
        const overlapEnd = Math.min(endAdj, windowEnd);
        if (overlapEnd > overlapStart) activeWithinWindow += (overlapEnd - overlapStart);
    }

    const idleSec = Math.max(0, shiftSec - activeWithinWindow);
    return secondsToHMMSS(idleSec);
}

// ============================================================
// Function 3: getActiveTime(shiftDuration, idleTime)
// activeTime = shiftDuration - idleTime; returns h:mm:ss
// ============================================================
function getActiveTime(shiftDuration, idleTime) {
    const shiftSec = parseDurationToSeconds(shiftDuration);
    const idleSec = parseDurationToSeconds(idleTime);
    const activeSec = Math.max(0, shiftSec - idleSec);
    return secondsToHMMSS(activeSec);
}

// Normal quota: 8h 24m. Eid al-Fitr (Apr 10–30, 2025): 6h.
const NORMAL_QUOTA_SEC = 8 * 3600 + 24 * 60;   // 8:24:00
const EID_QUOTA_SEC = 6 * 3600;                // 6:00:00
const EID_START = "2025-04-10";
const EID_END = "2025-04-30";

// ============================================================
// Function 4: metQuota(date, activeTime)
// Returns true if activeTime >= required daily quota (6h during Eid, 8h24m otherwise).
// ============================================================
function metQuota(date, activeTime) {
    if (!date || typeof date !== "string") return false;
    const d = date.trim();
    const inEid = d >= EID_START && d <= EID_END;
    const requiredSec = inEid ? EID_QUOTA_SEC : NORMAL_QUOTA_SEC;
    const activeSec = parseDurationToSeconds(activeTime);
    return activeSec >= requiredSec;
}

// ============================================================
// Function 5: addShiftRecord(textFile, shiftObj)
// Duplicate (same driverID + date) → return {}. Else add and return 10-property object.
// New record: appended at end if driverID absent; else inserted after last record of that driverID.
// ============================================================
function addShiftRecord(textFile, shiftObj) {
    if (!shiftObj || typeof textFile !== "string") return {};
    const { driverID, driverName, date, startTime, endTime } = shiftObj;
    if (driverID === undefined || driverName === undefined || date === undefined || startTime === undefined || endTime === undefined) return {};
    const idStr = String(driverID).trim();
    const dateStr = String(date).trim();
    try {
        let content = "";
        try {
            content = fs.readFileSync(textFile, "utf8");
        } catch (e) {
            // file missing: treat as empty
        }
        const lines = content.split("\n").filter(l => l.trim() !== "");
        for (const line of lines) {
            const parts = line.split(",");
            if (parts.length >= 3 && parts[0].trim() === idStr && parts[2].trim() === dateStr) return {};
        }
        const shiftDuration = getShiftDuration(startTime, endTime);
        const idleTime = getIdleTime(startTime, endTime);
        const activeTime = getActiveTime(shiftDuration, idleTime);
        const metQuotaVal = metQuota(date, activeTime);
        const hasBonus = false;
        const record = {
            driverID: String(driverID).trim(),
            driverName: String(driverName).trim(),
            date: dateStr,
            startTime: String(startTime).trim(),
            endTime: String(endTime).trim(),
            shiftDuration,
            idleTime,
            activeTime,
            metQuota: metQuotaVal,
            hasBonus
        };
        const newLine = [record.driverID, record.driverName, record.date, record.startTime, record.endTime, record.shiftDuration, record.idleTime, record.activeTime, record.metQuota, record.hasBonus].join(",");
        let insertIndex = lines.length;
        for (let i = lines.length - 1; i >= 0; i--) {
            const parts = lines[i].split(",");
            if (parts.length >= 1 && parts[0].trim() === idStr) {
                insertIndex = i + 1;
                break;
            }
        }
        lines.splice(insertIndex, 0, newLine);
        try {
            fs.writeFileSync(textFile, lines.join("\n") + "\n");
        } catch (e) {
            return {};
        }
        return record;
    } catch (e) {
        return {};
    }
}

// ============================================================
// Function 6: setBonus(textFile, driverID, date, newValue)
// Finds row by driverID and date, sets hasBonus to newValue; writes file. Returns nothing.
// ============================================================
function setBonus(textFile, driverID, date, newValue) {
    if (typeof textFile !== "string") return;
    let content;
    try {
        content = fs.readFileSync(textFile, "utf8");
    } catch (e) {
        return;
    }
    const idStr = String(driverID).trim();
    const dateStr = String(date).trim();
    const lines = content.split("\n").filter(l => l.trim() !== "");
    const out = lines.map(line => {
        const parts = line.split(",");
        if (parts.length < 10) return line;
        const [id, name, d, start, end, shiftDur, idle, active, quota] = parts;
        if (id.trim() === idStr && d.trim() === dateStr) {
            return [id, name, d, start, end, shiftDur, idle, active, quota, String(newValue)].join(",");
        }
        return line;
    });
    try {
        fs.writeFileSync(textFile, out.join("\n") + (out.length ? "\n" : ""));
    } catch (e) { }
}

// ============================================================
// Function 7: countBonusPerMonth(textFile, driverID, month)
// Counts records for driverID in given month (mm or m, e.g. "4" or "04") where hasBonus is true.
// Returns -1 if driverID does not exist in the file.
// ============================================================
function countBonusPerMonth(textFile, driverID, month) {
    if (typeof textFile !== "string") return -1;
    let content;
    try {
        content = fs.readFileSync(textFile, "utf8");
    } catch (e) {
        return -1;
    }
    const monthNorm = String(month).trim().padStart(2, "0");
    const driverIdStr = String(driverID).trim();
    const lines = content.split("\n").filter(l => l.trim() !== "");
    let foundDriver = false;
    let count = 0;
    for (const line of lines) {
        const parts = line.split(",");
        if (parts.length < 10) continue;
        const [id, , d, , , , , , , bonus] = parts;
        if (id.trim() !== driverIdStr) continue;
        foundDriver = true;
        const dateParts = d.trim().split("-");
        if (dateParts.length < 2) continue;
        const recMonth = dateParts[1].trim().padStart(2, "0");
        if (recMonth !== monthNorm) continue;
        if (String(bonus).trim().toLowerCase() === "true") count++;
    }
    return foundDriver ? count : -1;
}

// ============================================================
// Function 8: getTotalActiveHoursPerMonth(textFile, driverID, month)
// Sums activeTime for driverID in given month (number 1-12). Returns hhh:mm:ss.
// Includes all records (even on driver's day off).
// ============================================================
function getTotalActiveHoursPerMonth(textFile, driverID, month) {
    if (typeof textFile !== "string") return "000:00:00";
    let content;
    try {
        content = fs.readFileSync(textFile, "utf8");
    } catch (e) {
        return "000:00:00";
    }
    const monthNum = Number(month);
    if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) return "000:00:00";
    const monthStr = String(monthNum).padStart(2, "0");
    const driverIdStr = String(driverID).trim();
    const lines = content.split("\n").filter(l => l.trim() !== "");
    let totalSec = 0;
    for (const line of lines) {
        const parts = line.split(",");
        if (parts.length < 10) continue;
        const [id, , d, , , , , activeTime] = parts;
        if (id.trim() !== driverIdStr) continue;
        const dateParts = d.trim().split("-");
        if (dateParts.length < 2) continue;
        if (dateParts[1].trim().padStart(2, "0") !== monthStr) continue;
        totalSec += parseDurationToSeconds(activeTime);
    }
    return secondsToHHHMMSS(totalSec);
}

// --- Helper: get driver row from rate file ---
function getDriverRates(rateFile, driverID) {
    if (typeof rateFile !== "string") return null;
    try {
        const content = fs.readFileSync(rateFile, "utf8");
        const lines = content.split("\n").filter(l => l.trim() !== "");
        const idStr = String(driverID).trim();
        for (const line of lines) {
            const parts = line.split(",").map(p => p.trim());
            if (parts.length >= 4 && parts[0] === idStr) {
                return { driverID: parts[0], dayOff: parts[1], basePay: parseInt(parts[2], 10), tier: parseInt(parts[3], 10) };
            }
        }
    } catch (e) { }
    return null;
}

// --- Helper: days in month, day-of-week (0=Sun, 6=Sat) ---
function getDaysInMonth(month, year) {
    return new Date(year, month, 0).getDate();
}

function getDayOffCountInMonth(month, year, dayOffStr) {
    const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const dayIndex = names.indexOf((dayOffStr || "").trim().toLowerCase());
    if (dayIndex === -1) return 0;
    let count = 0;
    const days = getDaysInMonth(month, year);
    for (let d = 1; d <= days; d++) {
        const dayOfWeek = new Date(year, month - 1, d).getDay();
        if (dayOfWeek === dayIndex) count++;
    }
    return count;
}

// Is date (yyyy-mm-dd) in Eid al-Fitr period Apr 10–30, 2025?
function isDateInEidPeriod(dateStr) {
    return dateStr >= EID_START && dateStr <= EID_END;
}

// ============================================================
// Function 9: getRequiredHoursPerMonth(textFile, rateFile, bonusCount, driverID, month)
// Working days only (exclude driver's day off). Eid (Apr 10–30, 2025) = 6h/day; else 8h24m.
// Required reduced by 2 hours per bonus. Returns hhh:mm:ss.
// ============================================================
function getRequiredHoursPerMonth(textFile, rateFile, bonusCount, driverID, month) {
    const driver = getDriverRates(rateFile, driverID);
    if (!driver || typeof textFile !== "string") return "000:00:00";

    let content;
    try {
        content = fs.readFileSync(textFile, "utf8");
    } catch (e) {
        return "000:00:00";
    }

    const monthNum = Number(month);
    if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) return "000:00:00";

    const monthStr = String(monthNum).padStart(2, "0");
    const driverIdStr = String(driverID).trim();
    const dayOffStr = String(driver.dayOff).trim().toLowerCase();
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

    const lines = content.split("\n").filter(l => l.trim() !== "");
    let requiredSec = 0;

    for (const line of lines) {
        const parts = line.split(",");
        if (parts.length < 10) continue;

        const id = parts[0].trim();
        const dateStr = parts[2].trim();

        if (id !== driverIdStr) continue;

        const dateParts = dateStr.split("-");
        if (dateParts.length < 3) continue;

        const recMonth = dateParts[1].trim().padStart(2, "0");
        if (recMonth !== monthStr) continue;

        const dateObj = new Date(dateStr);
        const dayName = dayNames[dateObj.getDay()];

        if (dayName === dayOffStr) continue;

        if (isDateInEidPeriod(dateStr)) {
            requiredSec += EID_QUOTA_SEC;
        } else {
            requiredSec += NORMAL_QUOTA_SEC;
        }
    }

    requiredSec -= (Number(bonusCount) || 0) * 2 * 3600;
    if (requiredSec < 0) requiredSec = 0;

    return secondsToHHHMMSS(requiredSec);
}

// Tier allowed missing hours with no deduction: 1→50, 2→20, 3→10, 4→3
function getAllowedMissingHours(tier) {
    const map = { 1: 50, 2: 20, 3: 10, 4: 3 };
    return map[tier] || 0;
}

// ============================================================
// Function 10: getNetPay(driverID, actualHours, requiredHours, rateFile)
// No deduction if actual >= required. Else: allowance by tier, only full missing hours count.
// deductionRatePerHour = floor(basePay/185), salaryDeduction = billableMissingHours * rate, netPay = basePay - deduction.
// ============================================================
function getNetPay(driverID, actualHours, requiredHours, rateFile) {
    const driver = getDriverRates(rateFile, driverID);
    if (!driver) return 0;
    const basePay = driver.basePay;
    const requiredSec = parseDurationToSeconds(requiredHours);
    const actualSec = parseDurationToSeconds(actualHours);
    if (actualSec >= requiredSec) return basePay;
    const missingSec = requiredSec - actualSec;
    const missingHoursTotal = missingSec / 3600;
    const allowanceHours = getAllowedMissingHours(driver.tier);
    const remainingMissingHours = Math.max(0, missingHoursTotal - allowanceHours);
    const billableMissingHours = Math.floor(remainingMissingHours);
    const deductionRatePerHour = Math.floor(basePay / 185);
    const salaryDeduction = billableMissingHours * deductionRatePerHour;
    return basePay - salaryDeduction;
}

module.exports = {
    getShiftDuration,
    getIdleTime,
    getActiveTime,
    metQuota,
    addShiftRecord,
    setBonus,
    countBonusPerMonth,
    getTotalActiveHoursPerMonth,
    getRequiredHoursPerMonth,
    getNetPay
};
