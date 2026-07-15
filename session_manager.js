const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { formatRunTimestamp, ensureDir } = require('./output_files');
const { RunTiming } = require('./run_timing');
class SessionManager { constructor(){ this.sessions=new Map(); }
  async create({mode, appRoot, runStamp}={}){ const sessionId=`${mode||'session'}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`; const controller=new AbortController(); const s={sessionId,runStamp:runStamp||formatRunTimestamp(new Date()),mode,state:'running',abortController:controller,signal:controller.signal,stopRequested:false,cancelRequested:false,startedAt:Date.now(),currentPhase:'init',files:{},stats:{},timings:new RunTiming(),log:[],manifest:{sessionId,runStamp:null,status:'running',files:[]}}; s.manifest.runStamp=s.runStamp; if(appRoot){ s.sessionDir=path.join(appRoot,'FILES','download','.sessions',sessionId); await ensureDir(s.sessionDir); } this.sessions.set(sessionId,s); return s; }
  get(id){ return this.sessions.get(id); }
  requestStop(id){ const s=this.get(id); if(!s) return null; s.stopRequested=true; s.state='stopping'; s.abortController.abort('STOP_AND_SAVE'); return s; }
  requestCancel(id){ const s=this.get(id); if(!s) return null; s.cancelRequested=true; s.state='cancelling'; s.abortController.abort('CANCELLED'); return s; }
  async cleanup(id,{removeSessionDir=true}={}){ const s=this.get(id); this.sessions.delete(id); if(removeSessionDir && s?.sessionDir) await fs.promises.rm(s.sessionDir,{recursive:true,force:true}).catch(()=>{}); }
}
module.exports={SessionManager};
