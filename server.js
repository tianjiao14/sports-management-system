const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose(); 

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

// --- 多租户核心：全局赛事字典 ---
const tournaments = {};

function getT(code) {
    if (!tournaments[code]) {
        tournaments[code] = {
            courtQueues: {},    
            maxCourts: 6,       
            activeMatches: {},  
            allMatches: {},  
            globalTournamentName: "2026年体育赛事",   
            registrations: {}, 
            tieBlindBuffers: {}, 
            revealedTieData: {}, 
            availableGroups: ["初中组", "高中组", "小学甲组", "小学乙组"], 
            registrationDeadline: ""
        };
    }
    return tournaments[code];
}

// --- SQLite 数据库初始化与高并发持久化逻辑 (增加 code 联合主键) ---
const DB_PATH = path.join(__dirname, 'sports_data.db');
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS matches (code TEXT, id TEXT, data TEXT, PRIMARY KEY(code, id))");
    db.run("CREATE TABLE IF NOT EXISTS registrations (code TEXT, unit TEXT, data TEXT, PRIMARY KEY(code, unit))");
    db.run("CREATE TABLE IF NOT EXISTS config (code TEXT, key TEXT, value TEXT, PRIMARY KEY(code, key))");
});

function loadAllData() {
    db.all("SELECT code, id, data FROM matches", (err, rows) => {
        if (rows) rows.forEach(r => { 
            try { 
                const t = getT(r.code);
                t.allMatches[r.id] = JSON.parse(r.data); 
            } catch(e){} 
        });
        console.log(`✅ 历史比赛记录已恢复`);
    });
    db.all("SELECT code, unit, data FROM registrations", (err, rows) => {
        if (rows) rows.forEach(r => { 
            try { 
                const t = getT(r.code);
                t.registrations[r.unit] = JSON.parse(r.data); 
            } catch(e){} 
        });
        console.log(`✅ 报名数据已恢复`);
    });
    db.all("SELECT code, key, value FROM config", (err, rows) => {
        if (rows) rows.forEach(r => {
            try {
                const t = getT(r.code);
                const val = JSON.parse(r.value);
                if (r.key === 'courtQueues') t.courtQueues = val;
                if (r.key === 'maxCourts') t.maxCourts = val;
                if (r.key === 'globalTournamentName') t.globalTournamentName = val;
                if (r.key === 'availableGroups') t.availableGroups = val;
                if (r.key === 'tieBlindBuffers') t.tieBlindBuffers = val;
                if (r.key === 'revealedTieData') t.revealedTieData = val;
                if (r.key === 'registrationDeadline') t.registrationDeadline = val;
            } catch(e){}
        });
        console.log("✅ 赛事系统配置已恢复");
    });
}

setTimeout(loadAllData, 500);

// --- 数据持久化函数 ---
function saveConfig(code, key, value) { 
    db.run("INSERT OR REPLACE INTO config (code, key, value) VALUES (?, ?, ?)", [code, key, JSON.stringify(value)]); 
}
function saveMatch(code, id) { 
    const t = getT(code);
    if (t.allMatches[id]) db.run("INSERT OR REPLACE INTO matches (code, id, data) VALUES (?, ?, ?)", [code, id, JSON.stringify(t.allMatches[id])]); 
}
function deleteMatch(code, id) { 
    db.run("DELETE FROM matches WHERE code = ? AND id = ?", [code, id]); 
}
function saveRegistration(code, unit) { 
    const t = getT(code);
    if (t.registrations[unit]) db.run("INSERT OR REPLACE INTO registrations (code, unit, data) VALUES (?, ?, ?)", [code, unit, JSON.stringify(t.registrations[unit])]); 
}
function deleteRegistration(code, unit) { 
    db.run("DELETE FROM registrations WHERE code = ? AND unit = ?", [code, unit]); 
}

// --- 广播看板更新 (隔离至房间) ---
function sendScoreboardUpdate(code) {
    const t = getT(code);
    const matches = Object.values(t.allMatches);
    const allFinished = matches.filter(m => m.status === 'finished').sort((a, b) => b.finishTime - a.finishTime);
    const otherMatches = matches.filter(m => m.status !== 'finished').sort((a, b) => 
        (a.startTime || "").localeCompare(b.startTime || "") || parseInt(a.court) - parseInt(b.court)
    );
    const displayList = [...allFinished, ...otherMatches];
    io.to(code).emit('scoreboard_data', displayList);
}

function getPlayerNameFromFull(item) {
    if (!item) return "待定";
    if (Array.isArray(item)) {
        return item.map(p => String(p).split(/[\(（]/)[0].trim()).filter(p => p).join('/');
    }
    return String(item).split(/[\(（]/)[0].trim();
}

io.on('connection', (socket) => {
    console.log('新连接:', socket.id);

    // 核心：强制加入代码房间
    socket.on('join_tournament', (code) => {
        if (!code) return;
        socket.join(code);
        socket.tournamentCode = code;
        const t = getT(code);
        socket.emit('update_config', { maxCourts: t.maxCourts });
        socket.emit('update_tournament_name', t.globalTournamentName);
        socket.emit('groups_config', t.availableGroups); 
    });

    // --- A. 领队报名模块 ---
    socket.on('reg_login', (data) => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        const { unit, pass } = data;
        const defaultPass = "123456";
        if (!t.registrations[unit]) {
            t.registrations[unit] = { password: defaultPass, athletes: [], group: t.availableGroups[0] };
            saveRegistration(code, unit);
        }
        if (t.registrations[unit].password === pass) {
            socket.emit('reg_login_res', { success: true, unit, pass, tournamentName: t.globalTournamentName, data: t.registrations[unit] });
        } else {
            socket.emit('reg_login_res', { success: false, message: "密码错误！" });
        }
    });

    socket.on('reg_save', (data) => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        if (t.registrationDeadline) {
            const now = new Date();
            const deadline = new Date(t.registrationDeadline);
            if (now > deadline) {
                return socket.emit('reg_save_res', { 
                    success: false, 
                    message: `❌ 远程报名已于 ${t.registrationDeadline} 正式截止，当前系统已锁定，无法保存或修改数据！` 
                });
            }
        }
        const { unit, authPass, newPass, group, athletes, leaderName, leaderPhone, coachName, coachPhone, coachName2, coachPhone2 } = data;
        if (t.registrations[unit] && t.registrations[unit].password === authPass) {
            t.registrations[unit].password = newPass; 
            t.registrations[unit].group = group;
            t.registrations[unit].athletes = athletes;
            t.registrations[unit].leaderName = leaderName || "";
            t.registrations[unit].leaderPhone = leaderPhone || "";
            t.registrations[unit].coachName = coachName || "";
            t.registrations[unit].coachPhone = coachPhone || "";
            t.registrations[unit].coachName2 = coachName2 || "";
            t.registrations[unit].coachPhone2 = coachPhone2 || "";

            saveRegistration(code, unit);
            socket.emit('reg_save_res', { success: true });
            io.to(code).emit('all_registrations_data', t.registrations); 
        } else {
            socket.emit('reg_save_res', { success: false, message: "身份验证失败，请重新登录" });
        }
    });

    socket.on('get_all_registrations', () => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        socket.emit('all_registrations_data', t.registrations);
    });

    socket.on('set_tournament_name', (name) => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        t.globalTournamentName = name;
        saveConfig(code, 'globalTournamentName', name);
        io.to(code).emit('tournament_name_changed', name);
    });

    socket.on('get_tournament_name', () => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        socket.emit('send_tournament_name', t.globalTournamentName);
    });

    socket.on('set_registration_deadline', (dateTimeStr) => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        t.registrationDeadline = dateTimeStr;
        saveConfig(code, 'registrationDeadline', dateTimeStr);
        io.to(code).emit('registration_deadline_changed', dateTimeStr);
    });

    socket.on('get_registration_deadline', () => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        socket.emit('send_registration_deadline', t.registrationDeadline);
    });

    socket.on('unlock_match', (matchId) => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        if (t.activeMatches[matchId]) {
            delete t.activeMatches[matchId]; 
        }
        io.to(code).emit('match_occupied', { matchId: matchId, locked: false });
    });

    // --- B. 管理端配置模块 ---
    socket.on('set_groups', (groups) => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        t.availableGroups = groups;
        io.to(code).emit('groups_config', t.availableGroups); 
        t.registrations = {};
        db.run("DELETE FROM registrations WHERE code = ?", [code]);
        saveConfig(code, 'availableGroups', t.availableGroups);
        io.to(code).emit('all_registrations_data', t.registrations);
    });

    socket.on('admin_delete_athlete', (data) => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        const { unit, name } = data;
        if (t.registrations[unit]) {
            t.registrations[unit].athletes = t.registrations[unit].athletes.filter(a => a.name !== name);
            saveRegistration(code, unit);
            io.to(code).emit('all_registrations_data', t.registrations);
        }
    });

    socket.on('admin_delete_unit', (data) => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        const { unit } = data;
        if (t.registrations[unit]) {
            delete t.registrations[unit];
            deleteRegistration(code, unit);
            io.to(code).emit('all_registrations_data', t.registrations);
        }
    });

    socket.on('update_max_courts', (num) => { 
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        t.maxCourts = num; 
        saveConfig(code, 'maxCourts', num); 
        io.to(code).emit('update_config', { maxCourts: t.maxCourts }); 
    });

    socket.on('submit_full_tie_lineup', (data) => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        const { matchId, side, fullLineup } = data;
        const match = t.allMatches[matchId];
        if (!match) return;

        if (!t.tieBlindBuffers[matchId]) t.tieBlindBuffers[matchId] = { p1: null, p2: null };
        
        if (side === 1) t.tieBlindBuffers[matchId].p1 = fullLineup;
        if (side === 2) t.tieBlindBuffers[matchId].p2 = fullLineup;
        saveConfig(code, 'tieBlindBuffers', t.tieBlindBuffers);

        match.p1Submitted = !!t.tieBlindBuffers[matchId].p1;
        match.p2Submitted = !!t.tieBlindBuffers[matchId].p2;

        const q = t.courtQueues[match.court] || [];
        const qMatch = q.find(m => m.id === matchId);
        if (qMatch) {
            qMatch.p1Submitted = match.p1Submitted;
            qMatch.p2Submitted = match.p2Submitted;
        }

        io.to(code).emit('tie_lineup_submitted_status', { matchId, side });

        if (t.tieBlindBuffers[matchId].p1 && t.tieBlindBuffers[matchId].p2) {
            const revealPayload = { matchId: matchId, p1Full: t.tieBlindBuffers[matchId].p1, p2Full: t.tieBlindBuffers[matchId].p2 };
            
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

            t.revealedTieData[matchId] = revealPayload; 
            saveConfig(code, 'revealedTieData', t.revealedTieData);
            io.to(code).emit('tie_lineups_revealed', revealPayload);
        }
        
        saveMatch(code, matchId);
        saveConfig(code, 'courtQueues', t.courtQueues);
        io.to(`${code}_court_room_${match.court}`).emit(`court_${match.court}_match`, t.courtQueues[match.court]);
        sendScoreboardUpdate(code);
    });

    socket.on('push_match', (data) => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        const courtNum = data.court;
        if (!t.courtQueues[courtNum]) t.courtQueues[courtNum] = [];
        const isTeam = data.isTeamMatch === true || 
                       data.isTeamMatch === 'true' ||
                       data.isTeamEvent || 
                       (data.title && data.title.includes("团体")) || 
                       (data.sportType && (data.sportType.includes("团体") || data.sportType.includes("team")));

        let initialSubs = data.subMatches || [];
        if (isTeam && initialSubs.length === 0 && data.teamOrder && data.teamOrder.length > 0) {
            initialSubs = data.teamOrder.map((name, idx) => ({
                name: name, p1: "待定", p2: "待定", score: "0:0", p1Sets: 0, p2Sets: 0, status: idx === 0 ? "playing" : "waiting"
            }));
        }

        if (!t.allMatches[data.id]) {
            t.allMatches[data.id] = { 
                id: data.id, court: data.court, p1: data.p1, p2: data.p2, 
                matchType: data.title, sportType: data.sportType, startTime: data.time || "00:00", 
                status: 'waiting', 
                p1Score: 0, p2Score: 0, p1Sets: 0, p2Sets: 0, setScore: "0:0",
                teamOrder: data.teamOrder || [], isTeamMatch: isTeam, subMatches: initialSubs,
                p1Submitted: false, p2Submitted: false, tieRevealed: false, p1Full: null, p2Full: null
            };
        } else {
            t.allMatches[data.id].court = data.court;
            if (data.time) t.allMatches[data.id].startTime = data.time;
            t.allMatches[data.id].sportType = data.sportType;
            t.allMatches[data.id].matchType = data.title;
            
            t.allMatches[data.id].isTeamMatch = isTeam;
            if (isTeam && (!t.allMatches[data.id].subMatches || t.allMatches[data.id].subMatches.length === 0)) {
                t.allMatches[data.id].subMatches = initialSubs;
            }
        }

        const match = t.allMatches[data.id];
        const isAlreadyFinished = match.status === 'finished';
        const idx = t.courtQueues[courtNum].findIndex(m => String(m.id) === String(data.id));
        
        const mData = { 
            ...data, 
            isFinished: isAlreadyFinished, 
            subMatches: match.subMatches, 
            isTeamMatch: isTeam,
            sportType: match.sportType
        };
        if (idx !== -1) t.courtQueues[courtNum][idx] = mData; else t.courtQueues[courtNum].push(mData);

        saveMatch(code, data.id); 
        saveConfig(code, 'courtQueues', t.courtQueues);
        io.to(`${code}_court_room_${courtNum}`).emit(`court_${courtNum}_match`, t.courtQueues[courtNum]);
        sendScoreboardUpdate(code); 
    });

    socket.on('clear_court_queues', (courtNum) => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        if (courtNum === 'all') { 
            t.courtQueues = {}; t.allMatches = {}; t.activeMatches = {}; 
            db.run("DELETE FROM matches WHERE code = ?", [code]);
        } else {
            t.courtQueues[courtNum] = [];
            for (let id in t.allMatches) { 
                if (t.allMatches[id].court == courtNum) {
                    delete t.allMatches[id];
                    deleteMatch(code, id);
                } 
            }
        }
        saveConfig(code, 'courtQueues', t.courtQueues);
        io.to(code).emit('court_queues_cleared', courtNum);
        sendScoreboardUpdate(code); 
    });

    socket.on('join_court', (c) => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        socket.join(`${code}_court_room_${c}`);
        
        const items = (t.courtQueues[c] || []).map(m => {
            const realMatch = t.allMatches[m.id];
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
        
        const m = Object.values(t.allMatches).find(m => m.court == c && m.status === 'playing');
        if (m && t.revealedTieData[m.id]) socket.emit('tie_lineups_revealed', t.revealedTieData[m.id]);
    });

    socket.on('lock_match', (payload) => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        const matchId = typeof payload === 'string' ? payload : payload.matchId;
        const subMatchIndex = typeof payload === 'string' ? undefined : payload.subMatchIndex;

        if (t.activeMatches[matchId] && t.activeMatches[matchId] !== socket.id) {
            socket.emit('lock_status', { success: false, message: "该场比赛已被其他裁判锁定！" });
        } else {
            const match = t.allMatches[matchId];
            if (match && match.status === 'finished') {
                socket.emit('lock_status', { 
                    success: true, ...match, matchData: match,
                    frozenScore: { s1: match.p1Score, s2: match.p2Score, p1Sets: match.p1Sets, p2Sets: match.p2Sets, isSwapped: match.isSwapped || false, subMatches: match.subMatches || [] }
                }); return;
            }

            t.activeMatches[matchId] = socket.id;
            if (match) {
                if (match.status === 'waiting') match.status = 'playing';
                saveMatch(code, matchId);
                const isTeam = match.isTeamMatch || (match.matchType && match.matchType.includes("团体"));
                let currentS1 = 0, currentS2 = 0, currentP1Sets = 0, currentP2Sets = 0; let activeSubIndex = 0;

                if (isTeam && match.subMatches && match.subMatches.length > 0) {
                    let tP1 = 0, tP2 = 0;
                    match.subMatches.forEach(sm => {
                        if(sm.status === 'finished') { if(sm.p1Sets > sm.p2Sets) tP1++; else if(sm.p2Sets > sm.p1Sets) tP2++; }
                    });
                    match.p1Score = tP1; match.p2Score = tP2;

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
            socket.broadcast.to(code).emit('match_occupied', { matchId, locked: true, subMatchIndex }); sendScoreboardUpdate(code); 
        }
    });

    socket.on('update_score', (data) => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        io.to(code).emit('score_to_manager', data);
        if (t.allMatches[data.id]) {
            const match = t.allMatches[data.id];
            const isTeam = match.isTeamMatch || (match.matchType && match.matchType.includes("团体"));

            if (isTeam) {
                match.isTeamMatch = true;
                
                if (data.subMatchIndex !== undefined && data.subMatchScore !== undefined) {
                    const sIdx = parseInt(data.subMatchIndex, 10); 
                    if (match.subMatches && match.subMatches[sIdx]) {
                        match.subMatches[sIdx].score = data.subMatchScore; match.subMatches[sIdx].status = 'finished';
                        const finalSets = data.subMatchScore.split(':').map(Number);
                        if (finalSets.length === 2) { match.subMatches[sIdx].p1Sets = finalSets[0]; match.subMatches[sIdx].p2Sets = finalSets[1]; }

                        let tP1 = 0, tP2 = 0;
                        match.subMatches.forEach(sm => {
                            if (sm.status === 'finished') { if (sm.p1Sets > sm.p2Sets) tP1++; else if (sm.p2Sets > sm.p1Sets) tP2++; }
                        });
                        match.p1Score = tP1; match.p2Score = tP2;

                        const nextIdx = match.subMatches.findIndex(sm => sm.status === 'waiting');
                        if (nextIdx !== -1) { match.subMatches[nextIdx].status = 'playing'; match.subMatches[nextIdx].score = "0:0"; match.subMatches[nextIdx].p1Sets = 0; match.subMatches[nextIdx].p2Sets = 0; }

                        if (t.courtQueues[match.court]) {
                            let qMatch = t.courtQueues[match.court].find(m => String(m.id) === String(data.id));
                            if (qMatch) { qMatch.subMatches = match.subMatches; qMatch.p1Score = match.p1Score; qMatch.p2Score = match.p2Score; }
                            io.to(`${code}_court_room_${match.court}`).emit(`court_${match.court}_match`, t.courtQueues[match.court]);
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
            saveMatch(code, data.id);
            if (t.courtQueues[match.court]) {
                let qMatch = t.courtQueues[match.court].find(m => String(m.id) === String(data.id));
                if (qMatch) qMatch.subMatches = match.subMatches;
                saveConfig(code, 'courtQueues', t.courtQueues);
            }
            sendScoreboardUpdate(code); 
        }
    });

    socket.on('finish_match', (data) => {
        const code = socket.tournamentCode;
        if (!code) return;
        const t = getT(code);
        const courtNum = data.court;
        if (t.allMatches[data.id]) {
            const match = t.allMatches[data.id];
            const isTeam = match.isTeamMatch || (match.matchType && match.matchType.includes("团体"));
            
            if (isTeam) {
                if (data.isTeamEventEnd) {
                    match.status = 'finished'; 
                    match.finishTime = Date.now(); 
                    match.setScore = `${data.setScore1}:${data.setScore2}`;
                    delete t.activeMatches[data.id];
                } 
                else {
                    let activeIdx = match.subMatches.findIndex(sm => sm.status === 'playing');
                    if (activeIdx !== -1) {
                        const s1 = data.setScore1 !== undefined ? data.setScore1 : (match.p1Sets || 0);
                        const s2 = data.setScore2 !== undefined ? data.setScore2 : (match.p2Sets || 0);
                        
                        match.subMatches[activeIdx].status = 'finished';
                        match.subMatches[activeIdx].p1Sets = s1;
                        match.subMatches[activeIdx].p2Sets = s2;
                        match.subMatches[activeIdx].score = `${s1}:${s2}`;
                        
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

                    let p1Wins = 0, p2Wins = 0;
                    match.subMatches.forEach(sm => {
                        if (sm.status === 'finished') { if (sm.p1Sets > sm.p2Sets) p1Wins++; else if (sm.p2Sets > sm.p1Sets) p2Wins++; }
                    });
                    match.p1Score = p1Wins; match.p2Score = p2Wins;
                    
                   if ((p1Wins + p2Wins) === match.subMatches.length) {
                        match.status = 'finished'; 
                        match.finishTime = Date.now(); 
                        match.setScore = `${p1Wins}:${p2Wins}`;
                        delete t.activeMatches[data.id];
                    } else {
                        match.status = 'playing'; 
                    }
                }
            } else {
                delete t.activeMatches[data.id]; match.status = 'finished'; match.finishTime = Date.now();
                match.setHistory = data.details || ""; 
                match.p1Sets = data.setScore1 !== undefined ? data.setScore1 : data.score1; 
                match.p2Sets = data.setScore2 !== undefined ? data.setScore2 : data.score2; 
                match.setScore = `${match.p1Sets}:${match.p2Sets}`;
            }
            saveMatch(code, data.id);
        }

        if (t.courtQueues[courtNum]) {
            let qMatch = t.courtQueues[courtNum].find(m => String(m.id) === String(data.id));
            if (qMatch && t.allMatches[data.id]) {
                qMatch.isFinished = t.allMatches[data.id].status === 'finished'; 
                qMatch.finalScore = t.allMatches[data.id].setScore; 
                qMatch.subMatches = t.allMatches[data.id].subMatches;
            }
            saveConfig(code, 'courtQueues', t.courtQueues);
            io.to(`${code}_court_room_${courtNum}`).emit(`court_${courtNum}_match`, t.courtQueues[courtNum]);
        }
        
        if (t.allMatches[data.id] && t.allMatches[data.id].status === 'finished') {
            io.to(code).emit('match_occupied', { matchId: data.id, locked: false }); io.to(code).emit('result_to_manager', data);
        }
        sendScoreboardUpdate(code);
    });

    socket.on('request_all_scores', () => { 
        const code = socket.tournamentCode;
        if (!code) return;
        sendScoreboardUpdate(code); 
    });

    socket.on('disconnect', () => {
        for (let c in tournaments) {
            const t = tournaments[c];
            for (let mId in t.activeMatches) {
                if (t.activeMatches[mId] === socket.id) {
                    delete t.activeMatches[mId];
                    io.to(c).emit('match_occupied', { matchId: mId, locked: false });
                }
            }
        }
    });
});

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
    console.log(`🚀 体育赛事管理系统已启动 (多租户隔离版)`);
    console.log(`💻 管理端: http://${localIP}:${PORT}/index.html`);
    console.log(`📋 报名端: http://${localIP}:${PORT}/baoming.html?code=你的代码`);
    console.log(`🏸 裁判端: http://${localIP}:${PORT}/umpire.html?code=你的代码`);
    console.log(`📺 大屏幕: http://${localIP}:${PORT}/scoreboard.html?code=你的代码`);
    console.log('--------------------------------------');
});