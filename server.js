const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose(); // 引入高性能 SQLite 解决并发文件写入崩溃

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 托管当前目录下的所有原版 HTML 文件
app.use(express.static(__dirname));

// --- 你的全局变量声明 (保持原汁原味) ---
let courtQueues = {};    
let maxCourts = 6;       
let activeMatches = {};  
let allMatches = {};  
let globalTournamentName = "2026年体育赛事";   
let registrations = {}; 
let tieBlindBuffers = {}; 
let revealedTieData = {}; 
let availableGroups = ["初中组", "高中组", "小学甲组", "小学乙组"]; 
let registrationDeadline = "";

// --- SQLite 数据库初始化与高并发持久化逻辑 ---
const DB_PATH = path.join(__dirname, 'sports_data.db');
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
    // 创建独立数据表，彻底解决几十个场地同时打分时写同一个 JSON 文件导致的堵塞和坏档
    db.run("CREATE TABLE IF NOT EXISTS matches (id TEXT PRIMARY KEY, data TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS registrations (unit TEXT PRIMARY KEY, data TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)");
});

function loadAllData() {
    db.all("SELECT id, data FROM matches", (err, rows) => {
        if (rows) rows.forEach(r => { try { allMatches[r.id] = JSON.parse(r.data); } catch(e){} });
        console.log(`✅ 历史比赛记录已恢复 (${Object.keys(allMatches).length} 场)`);
    });
    db.all("SELECT unit, data FROM registrations", (err, rows) => {
        if (rows) rows.forEach(r => { try { registrations[r.unit] = JSON.parse(r.data); } catch(e){} });
        console.log(`✅ 报名数据已恢复 (${Object.keys(registrations).length} 个单位)`);
    });
    db.all("SELECT key, value FROM config", (err, rows) => {
        if (rows) rows.forEach(r => {
            try {
                const val = JSON.parse(r.value);
                if (r.key === 'courtQueues') courtQueues = val;
                if (r.key === 'maxCourts') maxCourts = val;
                if (r.key === 'globalTournamentName') globalTournamentName = val;
                if (r.key === 'availableGroups') availableGroups = val;
                if (r.key === 'tieBlindBuffers') tieBlindBuffers = val;
                if (r.key === 'revealedTieData') revealedTieData = val;
                if (r.key === 'registrationDeadline') registrationDeadline = val;
            } catch(e){}
        });
        console.log("✅ 赛事系统配置已恢复");
    });
}
// 延迟 500ms 加载，确保表创建完毕
setTimeout(loadAllData, 500);

// --- 核心优化：高频并发写入，直接原子化存入 SQLite，瞬间完成不堵塞 ---
function saveConfig(key, value) { db.run("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [key, JSON.stringify(value)]); }
function saveMatch(id) { if (allMatches[id]) db.run("INSERT OR REPLACE INTO matches (id, data) VALUES (?, ?)", [id, JSON.stringify(allMatches[id])]); }
function deleteMatch(id) { db.run("DELETE FROM matches WHERE id = ?", [id]); }
function saveRegistration(unit) { if (registrations[unit]) db.run("INSERT OR REPLACE INTO registrations (unit, data) VALUES (?, ?)", [unit, JSON.stringify(registrations[unit])]); }
function deleteRegistration(unit) { db.run("DELETE FROM registrations WHERE unit = ?", [unit]); }

// 广播看板更新
function sendScoreboardUpdate() {
    const matches = Object.values(allMatches);
    const allFinished = matches.filter(m => m.status === 'finished').sort((a, b) => b.finishTime - a.finishTime);
    const otherMatches = matches.filter(m => m.status !== 'finished').sort((a, b) => 
        (a.startTime || "").localeCompare(b.startTime || "") || parseInt(a.court) - parseInt(b.court)
    );
    const displayList = [...allFinished, ...otherMatches];
    io.emit('scoreboard_data', displayList);
}

// 🌟 【核心新增修复件】：全自动人名解包清洗器。完美击碎 Array 包装，干掉所有 (男)/(女) 后缀
function getPlayerNameFromFull(item) {
    if (!item) return "待定";
    if (Array.isArray(item)) {
        return item.map(p => String(p).split(/[\(（]/)[0].trim()).filter(p => p).join('/');
    }
    return String(item).split(/[\(（]/)[0].trim();
}

// --- server.js 核心监听区域（完整无错版） ---
io.on('connection', (socket) => {
    console.log('新连接:', socket.id);

    socket.emit('update_config', { maxCourts });
    socket.emit('update_tournament_name', globalTournamentName);
    socket.emit('groups_config', availableGroups); 

    // --- A. 领队报名模块 ---
    socket.on('reg_login', (data) => {
        const { unit, pass } = data;
        const defaultPass = "123456";
        if (!registrations[unit]) {
            registrations[unit] = { password: defaultPass, athletes: [], group: availableGroups[0] };
            saveRegistration(unit);
        }
        if (registrations[unit].password === pass) {
            socket.emit('reg_login_res', { success: true, unit, pass, tournamentName: globalTournamentName, data: registrations[unit] });
        } else {
            socket.emit('reg_login_res', { success: false, message: "密码错误！" });
        }
    });

    socket.on('reg_save', (data) => {
        if (registrationDeadline) {
            const now = new Date();
            const deadline = new Date(registrationDeadline);
            if (now > deadline) {
                return socket.emit('reg_save_res', { 
                    success: false, 
                    message: `❌ 远程报名已于 ${registrationDeadline} 正式截止，当前系统已锁定，无法保存或修改数据！` 
                });
            }
        }
        const { unit, authPass, newPass, group, athletes, leaderName, leaderPhone, coachName, coachPhone, coachName2, coachPhone2 } = data;
        if (registrations[unit] && registrations[unit].password === authPass) {
            registrations[unit].password = newPass; 
            registrations[unit].group = group;
            registrations[unit].athletes = athletes;
            registrations[unit].leaderName = leaderName || "";
            registrations[unit].leaderPhone = leaderPhone || "";
            registrations[unit].coachName = coachName || "";
            registrations[unit].coachPhone = coachPhone || "";
            registrations[unit].coachName2 = coachName2 || "";
            registrations[unit].coachPhone2 = coachPhone2 || "";

            saveRegistration(unit);
            socket.emit('reg_save_res', { success: true });
            io.emit('all_registrations_data', registrations); 
        } else {
            socket.emit('reg_save_res', { success: false, message: "身份验证失败，请重新登录" });
        }
    });

    socket.on('get_all_registrations', () => {
        socket.emit('all_registrations_data', registrations);
    });

    socket.on('set_tournament_name', (name) => {
        globalTournamentName = name;
        saveConfig('globalTournamentName', name);
        io.emit('tournament_name_changed', name);
    });

    socket.on('get_tournament_name', () => {
        socket.emit('send_tournament_name', globalTournamentName);
    });

    socket.on('set_registration_deadline', (dateTimeStr) => {
        registrationDeadline = dateTimeStr;
        saveConfig('registrationDeadline', dateTimeStr);
        io.emit('registration_deadline_changed', dateTimeStr);
    });

    socket.on('get_registration_deadline', () => {
        socket.emit('send_registration_deadline', registrationDeadline);
    });

    socket.on('unlock_match', (matchId) => {
       if (activeMatches[matchId]) {
            delete activeMatches[matchId]; 
        }
        io.emit('match_occupied', { matchId: matchId, locked: false });
    });

    // --- B. 管理端配置模块 ---
    socket.on('set_groups', (groups) => {
        availableGroups = groups;
        io.emit('groups_config', availableGroups); 
        registrations = {};
        db.run("DELETE FROM registrations");
        saveConfig('availableGroups', availableGroups);
        io.emit('all_registrations_data', registrations);
    });

    socket.on('admin_delete_athlete', (data) => {
        const { unit, name } = data;
        if (registrations[unit]) {
            registrations[unit].athletes = registrations[unit].athletes.filter(a => a.name !== name);
            saveRegistration(unit);
            io.emit('all_registrations_data', registrations);
        }
    });

    socket.on('admin_delete_unit', (data) => {
        const { unit } = data;
        if (registrations[unit]) {
            delete registrations[unit];
            deleteRegistration(unit);
            io.emit('all_registrations_data', registrations);
        }
    });

    socket.on('update_max_courts', (num) => { 
        maxCourts = num; 
        saveConfig('maxCourts', num); 
        io.emit('update_config', { maxCourts }); 
    });

    // 领队提交出场名单盲盒
    socket.on('submit_full_tie_lineup', (data) => {
        const { matchId, side, fullLineup } = data;
        const match = allMatches[matchId];
        if (!match) return;

        if (!tieBlindBuffers[matchId]) tieBlindBuffers[matchId] = { p1: null, p2: null };
        
        if (side === 1) tieBlindBuffers[matchId].p1 = fullLineup;
        if (side === 2) tieBlindBuffers[matchId].p2 = fullLineup;
        saveConfig('tieBlindBuffers', tieBlindBuffers);

        match.p1Submitted = !!tieBlindBuffers[matchId].p1;
        match.p2Submitted = !!tieBlindBuffers[matchId].p2;

        const q = courtQueues[match.court] || [];
        const qMatch = q.find(m => m.id === matchId);
        if (qMatch) {
            qMatch.p1Submitted = match.p1Submitted;
            qMatch.p2Submitted = match.p2Submitted;
        }

        io.emit('tie_lineup_submitted_status', { matchId, side });

        if (tieBlindBuffers[matchId].p1 && tieBlindBuffers[matchId].p2) {
            const revealPayload = { matchId: matchId, p1Full: tieBlindBuffers[matchId].p1, p2Full: tieBlindBuffers[matchId].p2 };
            
            match.tieRevealed = true;
            match.p1Full = revealPayload.p1Full;
            match.p2Full = revealPayload.p2Full;
            if (qMatch) {
                qMatch.tieRevealed = true;
                qMatch.p1Full = revealPayload.p1Full;
                qMatch.p2Full = revealPayload.p2Full;
            }

            if (!match.subMatches || match.subMatches.length === 0) {
                const orders = (match.teamOrder && match.teamOrder.length > 0) ? match.teamOrder : ["第一场", "第二场", "第三场"];
                match.subMatches = orders.map((name, idx) => ({
                    name: name, p1: "待定", p2: "待定", score: "0:0", p1Sets: 0, p2Sets: 0, status: idx === 0 ? "playing" : "waiting"
                }));
            }
            
            match.subMatches.forEach((sm, idx) => {
                if (match.p1Full && match.p1Full[idx]) sm.p1 = getPlayerNameFromFull(match.p1Full[idx]);
                if (match.p2Full && match.p2Full[idx]) sm.p2 = getPlayerNameFromFull(match.p2Full[idx]);
            });

            revealedTieData[matchId] = revealPayload; 
            saveConfig('revealedTieData', revealedTieData);
            io.emit('tie_lineups_revealed', revealPayload);
        }
        
        saveMatch(matchId);
        saveConfig('courtQueues', courtQueues);
        io.to(`court_room_${match.court}`).emit(`court_${match.court}_match`, courtQueues[match.court]);
        sendScoreboardUpdate();
    });

// --- C. 赛事推送模块 ---
   socket.on('push_match', (data) => {
        const courtNum = data.court;
        if (!courtQueues[courtNum]) courtQueues[courtNum] = [];
        const isTeam = data.isTeamMatch === true || 
                       data.isTeamMatch === 'true' ||
                       data.isTeamEvent || 
                       (data.title && data.title.includes("团体")) || 
                       (data.sportType && (data.sportType.includes("团体") || data.sportType.includes("team")));

        // 🌟 初始化子场次数据
        let initialSubs = data.subMatches || [];
        if (isTeam && initialSubs.length === 0 && data.teamOrder && data.teamOrder.length > 0) {
            initialSubs = data.teamOrder.map((name, idx) => ({
                name: name, p1: "待定", p2: "待定", score: "0:0", p1Sets: 0, p2Sets: 0, status: idx === 0 ? "playing" : "waiting"
            }));
        }

        // 核心修复 1：如果这场比赛完全不存在，全新初始化
        if (!allMatches[data.id]) {
            allMatches[data.id] = { 
                id: data.id, court: data.court, p1: data.p1, p2: data.p2, 
                matchType: data.title, sportType: data.sportType, startTime: data.time || "00:00", 
                status: 'waiting', 
                p1Score: 0, p2Score: 0, p1Sets: 0, p2Sets: 0, setScore: "0:0",
                teamOrder: data.teamOrder || [], isTeamMatch: isTeam, subMatches: initialSubs,
                p1Submitted: false, p2Submitted: false, tieRevealed: false, p1Full: null, p2Full: null
            };
        } else {
            // 🌟 核心修复 2：如果已经存在（脏数据缓存），强行覆写关键的团体赛属性！
            allMatches[data.id].court = data.court;
            if (data.time) allMatches[data.id].startTime = data.time;
            allMatches[data.id].sportType = data.sportType;
            allMatches[data.id].matchType = data.title;
            
            // 如果从个人赛改成了团体赛，强行把标记和子场次塞进去，防止走错样式
            allMatches[data.id].isTeamMatch = isTeam;
            if (isTeam && (!allMatches[data.id].subMatches || allMatches[data.id].subMatches.length === 0)) {
                allMatches[data.id].subMatches = initialSubs;
            }
        }

        const match = allMatches[data.id];
        const isAlreadyFinished = match.status === 'finished';
        const idx = courtQueues[courtNum].findIndex(m => String(m.id) === String(data.id));
        
        // 🌟 确保发往队列的数据携带正确的团体赛和子场次参数
        const mData = { 
            ...data, 
            isFinished: isAlreadyFinished, 
            subMatches: match.subMatches, 
            isTeamMatch: isTeam,
            sportType: match.sportType
        };
        if (idx !== -1) courtQueues[courtNum][idx] = mData; else courtQueues[courtNum].push(mData);

        saveMatch(data.id); saveConfig('courtQueues', courtQueues);
        io.to(`court_room_${courtNum}`).emit(`court_${courtNum}_match`, courtQueues[courtNum]);
        sendScoreboardUpdate(); 
    });

    socket.on('clear_court_queues', (courtNum) => {
        if (courtNum === 'all') { 
            courtQueues = {}; allMatches = {}; activeMatches = {}; 
            db.run("DELETE FROM matches");
        } else {
            courtQueues[courtNum] = [];
            for (let id in allMatches) { 
                if (allMatches[id].court == courtNum) {
                    delete allMatches[id];
                    deleteMatch(id);
                } 
            }
        }
        saveConfig('courtQueues', courtQueues);
        io.emit('court_queues_cleared', courtNum);
        sendScoreboardUpdate(); 
    });

    socket.on('join_court', (c) => {
        socket.join(`court_room_${c}`);
        
        const items = (courtQueues[c] || []).map(m => {
            const realMatch = allMatches[m.id];
            if (realMatch) {
                return {
                    ...m,
                    isFinished: realMatch.status === 'finished',
                    p1Score: realMatch.p1Score,
                    p2Score: realMatch.p2Score,
                    p1Sets: realMatch.p1Sets,
                    p2Sets: realMatch.p2Sets,
                    subMatches: realMatch.subMatches || []
                };
            }
            return m;
        });
        
        socket.emit(`court_${c}_match`, items);
        
        const m = Object.values(allMatches).find(m => m.court == c && m.status === 'playing');
        if (m && revealedTieData[m.id]) socket.emit('tie_lineups_revealed', revealedTieData[m.id]);
    });

    socket.on('lock_match', (payload) => {
        const matchId = typeof payload === 'string' ? payload : payload.matchId;
        const subMatchIndex = typeof payload === 'string' ? undefined : payload.subMatchIndex;

        if (activeMatches[matchId] && activeMatches[matchId] !== socket.id) {
            socket.emit('lock_status', { success: false, message: "该场比赛已被其他裁判锁定！" });
        } else {
            const match = allMatches[matchId];
            if (match && match.status === 'finished') {
                socket.emit('lock_status', { 
                    success: true, ...match, matchData: match,
                    frozenScore: { s1: match.p1Score, s2: match.p2Score, p1Sets: match.p1Sets, p2Sets: match.p2Sets, isSwapped: match.isSwapped || false, subMatches: match.subMatches || [] }
                }); return;
            }

            activeMatches[matchId] = socket.id;
            if (match) {
                if (match.status === 'waiting') match.status = 'playing';
                saveMatch(matchId);
                const isTeam = match.isTeamMatch || (match.matchType && match.matchType.includes("团体"));
                let currentS1 = 0, currentS2 = 0, currentP1Sets = 0, currentP2Sets = 0; let activeSubIndex = 0;

                if (isTeam && match.subMatches && match.subMatches.length > 0) {
                    let tP1 = 0, tP2 = 0;
                    match.subMatches.forEach(sm => {
                        if(sm.status === 'finished') { if(sm.p1Sets > sm.p2Sets) tP1++; else if(sm.p2Sets > sm.p1Sets) tP2++; }
                    });
                    match.p1Score = tP1; match.p2Score = tP2;

                    // 🌟 核心修复 1：服务器必须【绝对服从】裁判端传来的子场次索引！不能自己瞎猜！
                    if (subMatchIndex !== undefined && match.subMatches[subMatchIndex]) {
                        activeSubIndex = parseInt(subMatchIndex, 10);
                    } else {
                        activeSubIndex = match.subMatches.findIndex(sm => sm.status === 'playing');
                        if (activeSubIndex === -1) activeSubIndex = match.subMatches.findIndex(sm => sm.status === 'waiting');
                        if (activeSubIndex === -1) activeSubIndex = 0;
                    }
                    
                    if(match.subMatches[activeSubIndex] && match.subMatches[activeSubIndex].status === 'waiting') match.subMatches[activeSubIndex].status = 'playing';

                    let activeSub = match.subMatches[activeSubIndex];
                    if (activeSub) {
                        const pts = (activeSub.score || "0:0").split(':').map(Number);
                        currentS1 = pts[0] || 0; currentS2 = pts[1] || 0; currentP1Sets = activeSub.p1Sets || 0; currentP2Sets = activeSub.p2Sets || 0;
                    }
                } else {
                    currentS1 = match.p1Score || 0; currentS2 = match.p2Score || 0; currentP1Sets = match.p1Sets || 0; currentP2Sets = match.p2Sets || 0;
                }

                socket.emit('lock_status', { 
                    success: true, ...match, matchData: match, activeSubIndex: activeSubIndex, 
                    frozenScore: { s1: currentS1, s2: currentS2, p1Sets: currentP1Sets, p2Sets: currentP2Sets, teamP1Score: match.p1Score || 0, teamP2Score: match.p2Score || 0, isSwapped: match.isSwapped || false, subMatches: match.subMatches || [], currentSubIndex: activeSubIndex }
                });
            } else { socket.emit('lock_status', { success: true }); }
            socket.broadcast.emit('match_occupied', { matchId, locked: true, subMatchIndex }); sendScoreboardUpdate(); 
        }
    });

  socket.on('update_score', (data) => {
        io.emit('score_to_manager', data);
        if (allMatches[data.id]) {
            const match = allMatches[data.id];
            const isTeam = match.isTeamMatch || (match.matchType && match.matchType.includes("团体"));

            if (isTeam) {
                match.isTeamMatch = true;
                
                if (data.subMatchIndex !== undefined && data.subMatchScore !== undefined) {
                    const sIdx = parseInt(data.subMatchIndex, 10); 
                    if (match.subMatches && match.subMatches[sIdx]) {
                        match.subMatches[sIdx].score = data.subMatchScore; match.subMatches[sIdx].status = 'finished';
                        const finalSets = data.subMatchScore.split(':').map(Number);
                        if (finalSets.length === 2) { match.subMatches[sIdx].p1Sets = finalSets[0]; match.subMatches[sIdx].p2Sets = finalSets[1]; }

                        // 🌟 核心修复 6：每次提交一球，立即精准重算总比分
                        let tP1 = 0, tP2 = 0;
                        match.subMatches.forEach(sm => {
                            if (sm.status === 'finished') { if (sm.p1Sets > sm.p2Sets) tP1++; else if (sm.p2Sets > sm.p1Sets) tP2++; }
                        });
                        match.p1Score = tP1; match.p2Score = tP2;

                        // 自动解锁下一场
                        const nextIdx = match.subMatches.findIndex(sm => sm.status === 'waiting');
                        if (nextIdx !== -1) { match.subMatches[nextIdx].status = 'playing'; match.subMatches[nextIdx].score = "0:0"; match.subMatches[nextIdx].p1Sets = 0; match.subMatches[nextIdx].p2Sets = 0; }

                        if (courtQueues[match.court]) {
                            let qMatch = courtQueues[match.court].find(m => String(m.id) === String(data.id));
                            if (qMatch) { qMatch.subMatches = match.subMatches; qMatch.p1Score = match.p1Score; qMatch.p2Score = match.p2Score; }
                            io.to(`court_room_${match.court}`).emit(`court_${match.court}_match`, courtQueues[match.court]);
                        }
                    }
                } else if (data.s1 !== undefined && data.s2 !== undefined) {
                    let targetSub = match.subMatches.find(sm => sm.status === 'playing');
                    if (!targetSub && data.subMatchIndex !== undefined) targetSub = match.subMatches[parseInt(data.subMatchIndex, 10)];
                    if (!targetSub) targetSub = match.subMatches[0];

                    if (targetSub && targetSub.status !== 'finished') { targetSub.score = `${data.s1}:${data.s2}`; targetSub.p1Sets = data.p1Sets || 0; targetSub.p2Sets = data.p2Sets || 0; }
                }
            } else { match.p1Score = data.s1; match.p2Score = data.s2; }

            match.isSwapped = data.isSwapped || false; 
            saveMatch(data.id);
            if (courtQueues[match.court]) {
                let qMatch = courtQueues[match.court].find(m => String(m.id) === String(data.id));
                if (qMatch) qMatch.subMatches = match.subMatches;
                saveConfig('courtQueues', courtQueues);
            }
            sendScoreboardUpdate(); 
        }
    });


    socket.on('finish_match', (data) => {
        const courtNum = data.court;
        if (allMatches[data.id]) {
            const match = allMatches[data.id];
            const isTeam = match.isTeamMatch || (match.matchType && match.matchType.includes("团体"));
            
            if (isTeam) {
                // 🌟 新增：如果前端点击了黄色大按钮，明确要求结束整场比赛
                if (data.isTeamEventEnd) {
                    match.status = 'finished'; 
                    match.finishTime = Date.now(); 
                    match.setScore = `${data.setScore1}:${data.setScore2}`;
                    delete activeMatches[data.id];
                } 
                // 🌟 兼容原有防御逻辑（用于异常强制结算或弃权等）
                else {
                    let activeIdx = match.subMatches.findIndex(sm => sm.status === 'playing');
                    if (activeIdx !== -1) {
                        const s1 = data.setScore1 !== undefined ? data.setScore1 : (match.p1Sets || 0);
                        const s2 = data.setScore2 !== undefined ? data.setScore2 : (match.p2Sets || 0);
                        
                        match.subMatches[activeIdx].status = 'finished';
                        match.subMatches[activeIdx].p1Sets = s1;
                        match.subMatches[activeIdx].p2Sets = s2;
                        match.subMatches[activeIdx].score = `${s1}:${s2}`;
                        
                        // 自动给下一场通电准备
                        if (match.subMatches[activeIdx + 1]) {
                            match.subMatches[activeIdx + 1].status = 'playing';
                        }
                    }

                    if (data.subMatches && data.subMatches.length > 0) {
                        data.subMatches.forEach((clientSm, idx) => {
                            if (match.subMatches[idx] && clientSm.status === 'finished') {
                                match.subMatches[idx].status = 'finished'; match.subMatches[idx].score = clientSm.score;
                                match.subMatches[idx].p1Sets = clientSm.p1Sets; match.subMatches[idx].p2Sets = clientSm.p2Sets;
                            }
                        });
                    }

                    // 重新精准核算大比分
                    let p1Wins = 0, p2Wins = 0;
                    match.subMatches.forEach(sm => {
                        if (sm.status === 'finished') { if (sm.p1Sets > sm.p2Sets) p1Wins++; else if (sm.p2Sets > sm.p1Sets) p2Wins++; }
                    });
                    match.p1Score = p1Wins; match.p2Score = p2Wins;
                    
                   if ((p1Wins + p2Wins) === match.subMatches.length) {
                        match.status = 'finished'; 
                        match.finishTime = Date.now(); 
                        match.setScore = `${p1Wins}:${p2Wins}`;
                        delete activeMatches[data.id];
                    } else {
                        match.status = 'playing'; // 保留在打状态，允许裁判继续打 3:0 的死球！
                    }
                }
            } else {
                // 单项赛逻辑保持不变
                delete activeMatches[data.id]; match.status = 'finished'; match.finishTime = Date.now();
                match.setHistory = data.details || ""; 
                match.p1Sets = data.setScore1 !== undefined ? data.setScore1 : data.score1; 
                match.p2Sets = data.setScore2 !== undefined ? data.setScore2 : data.score2; 
                match.setScore = `${match.p1Sets}:${match.p2Sets}`;
            }
            saveMatch(data.id);
        }

        if (courtQueues[courtNum]) {
            let qMatch = courtQueues[courtNum].find(m => String(m.id) === String(data.id));
            if (qMatch && allMatches[data.id]) {
                qMatch.isFinished = allMatches[data.id].status === 'finished'; 
                qMatch.finalScore = allMatches[data.id].setScore; 
                qMatch.subMatches = allMatches[data.id].subMatches;
            }
            saveConfig('courtQueues', courtQueues);
            io.to(`court_room_${courtNum}`).emit(`court_${courtNum}_match`, courtQueues[courtNum]);
        }
        
        if (allMatches[data.id] && allMatches[data.id].status === 'finished') {
            io.emit('match_occupied', { matchId: data.id, locked: false }); io.emit('result_to_manager', data);
        }
        sendScoreboardUpdate();
    });

    socket.on('request_all_scores', () => { sendScoreboardUpdate(); });

    socket.on('disconnect', () => {
        for (let mId in activeMatches) {
            if (activeMatches[mId] === socket.id) {
                delete activeMatches[mId];
                io.emit('match_occupied', { matchId: mId, locked: false });
            }
        }
    });
});
// --- server.js 核心监听区域结束 ---
const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    const interfaces = os.networkInterfaces();
    let localIP = '127.0.0.1';
    for (let devName in interfaces) {
        interfaces[devName].forEach((details) => {
            if (details.family === 'IPv4' && !details.internal) localIP = details.address;
        });
    }
    console.log('--------------------------------------');
    console.log(`🚀 体育赛事管理系统已启动`);
    console.log(`💻 管理端: http://${localIP}:${PORT}/index.html`);
    console.log(`📋 报名端: http://${localIP}:${PORT}/baoming.html`);
    console.log(`🏸 裁判端: http://${localIP}:${PORT}/umpire.html`);
    console.log(`📺 大屏幕: http://${localIP}:${PORT}/scoreboard.html`);
    console.log('--------------------------------------');
});