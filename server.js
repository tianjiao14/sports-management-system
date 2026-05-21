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
        const isAlreadyFinished = allMatches[data.id] && allMatches[data.id].status === 'finished';
        const idx = courtQueues[courtNum].findIndex(m => String(m.id) === String(data.id));
        const mData = { ...data, isFinished: isAlreadyFinished || (idx !== -1 && courtQueues[courtNum][idx].isFinished) };
        if (idx !== -1) courtQueues[courtNum][idx] = mData;
        else courtQueues[courtNum].push(mData);

        if (!allMatches[data.id] || allMatches[data.id].status !== 'finished') {
            const isTeam = data.isTeamMatch || data.isTeamEvent || (data.title && data.title.includes("团体"));
            
            if (tieBlindBuffers[data.id]) delete tieBlindBuffers[data.id]; 
            if (revealedTieData[data.id]) delete revealedTieData[data.id];

            let initialSubs = data.subMatches || [];
            if (isTeam && initialSubs.length === 0 && data.teamOrder && data.teamOrder.length > 0) {
                initialSubs = data.teamOrder.map((name, idx) => ({
                    name: name, p1: "待定", p2: "待定", score: "0:0", p1Sets: 0, p2Sets: 0, status: idx === 0 ? "playing" : "waiting"
                }));
            }

            allMatches[data.id] = { 
                id: data.id, court: data.court, p1: data.p1, p2: data.p2, 
                matchType: data.title, sportType: data.sportType, startTime: data.time || "00:00", 
                status: 'waiting', 
                p1Score: 0, p2Score: 0, 
                p1Sets: 0, p2Sets: 0, 
                setScore: "0:0",
                teamOrder: data.teamOrder || [],
                isTeamMatch: isTeam,
                subMatches: initialSubs,
                p1Submitted: false,
                p2Submitted: false,
                tieRevealed: false,
                p1Full: null,
                p2Full: null
            };

            const currentQMatch = courtQueues[courtNum].find(m => String(m.id) === String(data.id));
            if (currentQMatch) {
                currentQMatch.p1Submitted = false;
                currentQMatch.p2Submitted = false;
                currentQMatch.tieRevealed = false;
                currentQMatch.p1Full = null;
                currentQMatch.p2Full = null;
            }

            saveMatch(data.id);
        }
        
        saveConfig('courtQueues', courtQueues);
        saveConfig('tieBlindBuffers', tieBlindBuffers); 
        saveConfig('revealedTieData', revealedTieData);

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
                console.log(`🚫 拦截二次误触：比赛 ${matchId} 已经是完赛状态，拒绝重复锁定。`);
                socket.emit('lock_status', { 
                    success: true, 
                    frozenScore: {
                        s1: match.p1Score, 
                        s2: match.p2Score,
                        p1Sets: match.p1Sets,
                        p2Sets: match.p2Sets,
                        isSwapped: match.isSwapped || false,
                        subMatches: match.subMatches || []
                    }
                });
                return;
            }

            activeMatches[matchId] = socket.id;
            if (match) {
                if (match.status === 'waiting') {
                    match.status = 'playing';
                }
                saveMatch(matchId);
                
                socket.emit('lock_status', { 
                    success: true, 
                    frozenScore: {
                        s1: match.p1Score || 0, 
                        s2: match.p2Score || 0,
                        p1Sets: match.p1Sets || 0,
                        p2Sets: match.p2Sets || 0,
                        isSwapped: match.isSwapped || false,
                        subMatches: match.subMatches || []
                    }
                });
            } else {
                socket.emit('lock_status', { success: true });
            }
            socket.broadcast.emit('match_occupied', { matchId, locked: true, subMatchIndex });
            sendScoreboardUpdate(); 
        }
    });

    socket.on('update_score', (data) => {
        io.emit('score_to_manager', data);
        if (allMatches[data.id]) {
            const match = allMatches[data.id];
            const isTeam = match.isTeamMatch || (match.matchType && match.matchType.includes("团体"));

            if (isTeam) {
                match.isTeamMatch = true;
                if (data.teamScore) {
                    const [ts1, ts2] = data.teamScore.split(':').map(Number);
                    match.p1Score = ts1; match.p2Score = ts2;
                }

                if (!match.subMatches || match.subMatches.length === 0) {
                    const orders = (match.teamOrder && match.teamOrder.length > 0) ? match.teamOrder : ["第一场", "第二场", "第三场"];
                    match.subMatches = orders.map((name, idx) => ({
                        name: name, p1: "待定", p2: "待定", score: "0:0", p1Sets: 0, p2Sets: 0, status: idx === 0 ? "playing" : "waiting"
                    }));
                }

                if (data.subMatchIndex !== undefined && data.subMatchScore !== undefined) {
                    const sIdx = data.subMatchIndex;
                    if (match.subMatches && match.subMatches[sIdx]) {
                        match.subMatches[sIdx].score = data.subMatchScore;
                        match.subMatches[sIdx].status = 'finished'; 
                        
                        const finalSets = data.subMatchScore.split(':').map(Number);
                        if (finalSets.length === 2) {
                            match.subMatches[sIdx].p1Sets = finalSets[0];
                            match.subMatches[sIdx].p2Sets = finalSets[1];
                        }
                        
                        if (match.subMatches[sIdx + 1]) {
                            match.subMatches.forEach((sm, i) => {
                                if (i === sIdx + 1) {
                                    sm.status = 'playing';
                                    sm.score = "0:0";
                                    sm.p1Sets = 0;
                                    sm.p2Sets = 0;
                                } else if (i > sIdx + 1) {
                                    sm.status = 'waiting';
                                    sm.score = "0:0";
                                    sm.p1Sets = 0;
                                    sm.p2Sets = 0;
                                }
                            });
                        }
                    }
                } else if (data.s1 !== undefined && data.s2 !== undefined) {
                    let targetSub = match.subMatches.find(sm => sm.status === 'playing');
                    if (!targetSub && data.subMatchIndex !== undefined) targetSub = match.subMatches[data.subMatchIndex];
                    if (!targetSub) targetSub = match.subMatches[0];

                    if (targetSub && targetSub.status !== 'finished') { 
                        targetSub.score = `${data.s1}:${data.s2}`;
                        targetSub.p1Sets = data.p1Sets || 0; 
                        targetSub.p2Sets = data.p2Sets || 0; 
                    }
                }

                if (match.p1Full || match.p2Full) {
                    match.subMatches.forEach((sm, idx) => {
                        if (match.p1Full && match.p1Full[idx] && (sm.p1 === "待定" || !sm.p1)) sm.p1 = getPlayerNameFromFull(match.p1Full[idx]);
                        if (match.p2Full && match.p2Full[idx] && (sm.p2 === "待定" || !sm.p2)) sm.p2 = getPlayerNameFromFull(match.p2Full[idx]);
                    });
                }

                if (courtQueues[match.court]) {
                    let qMatch = courtQueues[match.court].find(m => String(m.id) === String(data.id));
                    if (qMatch) qMatch.subMatches = match.subMatches;
                }
                saveMatch(data.id);
                saveConfig('courtQueues', courtQueues);

            } else {
                match.p1Score = data.s1; 
                match.p2Score = data.s2;
            }

            match.p1Sets = data.p1Sets || 0;
            match.p2Sets = data.p2Sets || 0;
            match.isSwapped = data.isSwapped || false; 

            saveMatch(data.id);
            sendScoreboardUpdate(); 
        }
    });

    socket.on('finish_match', (data) => {
        const courtNum = data.court;
        delete activeMatches[data.id];
        if (allMatches[data.id]) {
            const match = allMatches[data.id];
            match.status = 'finished'; 
            match.finishTime = Date.now();
            
            const isTeam = match.isTeamMatch || (match.matchType && match.matchType.includes("团体"));
            if (isTeam) {
                match.isTeamMatch = true;
                match.p1Score = data.setScore1; match.p2Score = data.setScore2; match.setScore = `${data.setScore1}:${data.setScore2}`;
                if (data.subMatches) match.subMatches = data.subMatches;
                
                if (match.subMatches && match.subMatches.length > 0) {
                    match.subMatches.forEach((sm) => {
                        if (sm.status === 'waiting') {
                            sm.score = "0:0";
                            sm.p1Sets = 0;
                            sm.p2Sets = 0;
                        }
                    });
                }
            } else {
                match.setHistory = data.details || ""; match.p1Sets = data.setScore1; match.p2Sets = data.setScore2; match.setScore = `${data.setScore1}:${data.setScore2}`;
            }
            saveMatch(data.id);
        }
        if (courtQueues[courtNum]) {
            let qMatch = courtQueues[courtNum].find(m => String(m.id) === String(data.id));
            if (qMatch) { 
                qMatch.isFinished = true; 
                qMatch.finalScore = `${data.setScore1}:${data.setScore2}`; 
                qMatch.details = data.details;
                
                if (qMatch.subMatches) {
                    qMatch.subMatches.forEach(sm => {
                        if (sm.status === 'waiting') { sm.score = "0:0"; sm.p1Sets = 0; sm.p2Sets = 0; }
                    });
                }
            }
            saveConfig('courtQueues', courtQueues);
            io.to(`court_room_${courtNum}`).emit(`court_${courtNum}_match`, courtQueues[courtNum]);
        }
        io.emit('match_occupied', { matchId: data.id, locked: false });
        io.emit('result_to_manager', data);
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