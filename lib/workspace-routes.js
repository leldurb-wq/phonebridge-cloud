const crypto = require('node:crypto');

function installWorkspaceRoutes({app,requireOwner,supabaseAdmin,rateLimit,FILE_BUCKET,FILE_LIMIT,ACCOUNT_STORAGE_LIMIT,cleanFileName,readUpload,getUserStorageUsage}) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  async function audit(userId,eventType,label='') {
    try {
      const {error}=await supabaseAdmin.from('security_events').insert({user_id:userId,event_type:eventType,device_label:String(label||'').slice(0,160)||null});
      if(error)throw error;
    } catch (error) { console.warn('[PhoneBridge audit]',error?.message||error); }
  }
  app.get('/api/health',(req,res)=>res.status(200).json({ok:true,service:'Phone Bridge Cloud'}));

  const fail = (res,error,message='Workspace service is temporarily unavailable.') => {
    console.error('[PhoneBridge workspace]',error?.message||error);
    if(error?.status)return res.status(error.status).json({ok:false,error:error.message});
    return res.status(503).json({ok:false,error:message});
  };

  app.post('/api/folders',rateLimit(30,10*60*1000),async(req,res)=>{
    const user=await requireOwner(req,res);if(!user)return;
    const name=typeof req.body?.name==='string'?req.body.name.trim():'';
    if(!name||name.length>80||/[\\/\\x00-\\x1f]/.test(name))return res.status(400).json({ok:false,error:'Folder names must be 1–80 characters and cannot contain slashes.'});
    try{
      const {data,error}=await supabaseAdmin.from('drive_folders').upsert({user_id:user.id,name},{onConflict:'user_id,name',ignoreDuplicates:true}).select('name').maybeSingle();
      if(error)throw error;
      await audit(user.id,'folder_created',name);
      return res.status(201).json({ok:true,folder:data?.name||name});
    }catch(error){return fail(res,error,'Could not create this Drive folder. Apply migration 008 and try again.')}
  });

  app.get('/api/sync/manifest',rateLimit(60,60*1000),async(req,res)=>{
    const user=await requireOwner(req,res);if(!user)return;
    try{
      const [{data:items,error:itemError},{data:history,error:historyError}]=await Promise.all([
        supabaseAdmin.from('sync_items').select('relative_path,size_bytes,source_mtime,content_sha256,updated_at').eq('user_id',user.id).order('updated_at',{ascending:false}).limit(2000),
        supabaseAdmin.from('sync_history').select('id,relative_path,size_bytes,source_mtime,saved_at').eq('user_id',user.id).order('saved_at',{ascending:false}).limit(100)
      ]);
      if(itemError)throw itemError;if(historyError)throw historyError;
      return res.json({ok:true,items:(items||[]).map(x=>({path:x.relative_path,size:Number(x.size_bytes),mtime:Number(x.source_mtime),updatedAt:x.updated_at})),history:(history||[]).map(x=>({id:x.id,path:x.relative_path,size:Number(x.size_bytes),mtime:Number(x.source_mtime),savedAt:x.saved_at}))});
    }catch(error){return fail(res,error,'Could not load sync history. Apply migration 008 and try again.')}
  });

  app.post('/api/sync/upload',rateLimit(60,10*60*1000),async(req,res)=>{
    const user=await requireOwner(req,res);if(!user)return;
    if(!supabaseAdmin)return res.status(503).json({ok:false,error:'File storage is not configured.'});
    let objectPath=null,fileId=null;
    try{
      let rel='';
      try{rel=decodeURIComponent(String(req.get('x-pb-sync-path')||''))}catch{return res.status(400).json({ok:false,error:'Invalid sync path encoding.'})}
      rel=rel.replace(/\\/g,'/').split('/').filter(Boolean).map(part=>cleanFileName(part)).join('/');
      if(!rel||rel.length>500||rel.split('/').some(part=>part==='.'||part==='..'))return res.status(400).json({ok:false,error:'Choose a valid relative file path.'});
      const buffer=await readUpload(req);if(!buffer.length)return res.status(400).json({ok:false,error:'The selected file is empty.'});
      const sourceMtime=Math.max(0,Math.floor(Number(req.get('x-pb-sync-mtime')||0)));
      const sha256=crypto.createHash('sha256').update(buffer).digest('hex');
      const {data:existing,error:existingError}=await supabaseAdmin.from('sync_items').select('file_id,size_bytes,source_mtime,content_sha256').eq('user_id',user.id).eq('relative_path',rel).maybeSingle();
      if(existingError)throw existingError;
      if(existing?.content_sha256===sha256)return res.json({ok:true,unchanged:true,path:rel});
      const used=await getUserStorageUsage(user.id);
      if(used+buffer.length>ACCOUNT_STORAGE_LIMIT)return res.status(413).json({ok:false,error:'Your 10 GB PhoneBridge storage limit would be exceeded.'});
      const base=cleanFileName(rel.split('/').pop());
      objectPath=user.id+'/sync/'+crypto.randomUUID()+'/'+base;
      const mime=String(req.get('content-type')||'application/octet-stream').split(';')[0].slice(0,120);
      const {error:uploadError}=await supabaseAdmin.storage.from(FILE_BUCKET).upload(objectPath,buffer,{contentType:mime,upsert:false});
      if(uploadError)throw uploadError;
      fileId=crypto.randomUUID();const now=new Date().toISOString();
      const fileRow={id:fileId,user_id:user.id,object_path:objectPath,original_name:base,mime_type:mime,size_bytes:buffer.length,folder:'Synced',created_at:now,updated_at:now};
      const {error:fileError}=await supabaseAdmin.from('user_files').insert(fileRow);if(fileError)throw fileError;
      if(existing){
        const {error:historyError}=await supabaseAdmin.from('sync_history').insert({user_id:user.id,relative_path:rel,file_id:existing.file_id,size_bytes:Number(existing.size_bytes||0),source_mtime:Number(existing.source_mtime||0),content_sha256:existing.content_sha256});
        if(historyError)throw historyError;
      }
      const {error:syncError}=await supabaseAdmin.from('sync_items').upsert({user_id:user.id,relative_path:rel,file_id:fileId,size_bytes:buffer.length,source_mtime:sourceMtime,content_sha256:sha256,updated_at:now},{onConflict:'user_id,relative_path'});
      if(syncError)throw syncError;
      await audit(user.id,'sync_uploaded',rel);
      return res.status(201).json({ok:true,unchanged:false,path:rel,size:buffer.length});
    }catch(error){
      if(fileId)await supabaseAdmin.from('user_files').delete().eq('id',fileId).eq('user_id',user.id).catch(()=>{});
      if(objectPath)await supabaseAdmin.storage.from(FILE_BUCKET).remove([objectPath]).catch(()=>{});
      return fail(res,error,'Sync upload failed. Your previous Drive copy was kept.');
    }
  });

  app.post('/api/sync/restore',rateLimit(30,10*60*1000),async(req,res)=>{
    const user=await requireOwner(req,res);if(!user)return;
    const historyId=String(req.body?.historyId||'');if(!uuid.test(historyId))return res.status(400).json({ok:false,error:'Choose a valid sync history version.'});
    try{
      const {data:version,error:versionError}=await supabaseAdmin.from('sync_history').select('relative_path,file_id,size_bytes,source_mtime,content_sha256').eq('id',historyId).eq('user_id',user.id).maybeSingle();
      if(versionError)throw versionError;if(!version?.file_id)return res.status(404).json({ok:false,error:'That saved version is no longer available.'});
      const {data:file,error:fileError}=await supabaseAdmin.from('user_files').select('id').eq('id',version.file_id).eq('user_id',user.id).maybeSingle();
      if(fileError)throw fileError;if(!file)return res.status(404).json({ok:false,error:'The saved file has been removed from Drive.'});
      const {data:current,error:currentError}=await supabaseAdmin.from('sync_items').select('file_id,size_bytes,source_mtime,content_sha256').eq('user_id',user.id).eq('relative_path',version.relative_path).maybeSingle();
      if(currentError)throw currentError;
      if(current&&current.file_id!==version.file_id){
        const {error:historyError}=await supabaseAdmin.from('sync_history').insert({user_id:user.id,relative_path:version.relative_path,file_id:current.file_id,size_bytes:current.size_bytes,source_mtime:current.source_mtime,content_sha256:current.content_sha256});
        if(historyError)throw historyError;
      }
      const {error:restoreError}=await supabaseAdmin.from('sync_items').upsert({user_id:user.id,relative_path:version.relative_path,file_id:version.file_id,size_bytes:version.size_bytes,source_mtime:version.source_mtime,content_sha256:version.content_sha256,updated_at:new Date().toISOString()},{onConflict:'user_id,relative_path'});
      if(restoreError)throw restoreError;
      await audit(user.id,'sync_restored',version.relative_path);
      return res.json({ok:true,path:version.relative_path});
    }catch(error){return fail(res,error,'Could not restore this sync version.')}
  });

  app.get('/api/notes',rateLimit(90,60*1000),async(req,res)=>{
    const user=await requireOwner(req,res);if(!user)return;
    try{
      if(req.query.id){
        const id=String(req.query.id);if(!uuid.test(id))return res.status(400).json({ok:false,error:'Choose a valid note.'});
        const {data,error}=await supabaseAdmin.from('notes').select('id,title,body,updated_at').eq('id',id).eq('user_id',user.id).maybeSingle();
        if(error)throw error;if(!data)return res.status(404).json({ok:false,error:'This note was not found.'});
        return res.json({id:data.id,title:data.title,text:data.body,updated:data.updated_at});
      }
      const {data,error}=await supabaseAdmin.from('notes').select('id,title,body,updated_at').eq('user_id',user.id).order('updated_at',{ascending:false}).limit(500);
      if(error)throw error;
      return res.json({ok:true,notes:(data||[]).map(n=>({id:n.id,title:n.title,preview:String(n.body||'').slice(0,140),updated:n.updated_at}))});
    }catch(error){return fail(res,error,'Could not load workspace notes.')}
  });

  app.post('/api/notes',rateLimit(60,10*60*1000),async(req,res)=>{
    const user=await requireOwner(req,res);if(!user)return;
    const title=typeof req.body?.title==='string'?req.body.title.trim()||'Untitled note':'Untitled note';
    const body=typeof req.body?.text==='string'?req.body.text:'';
    if(title.length>100||body.length>50000)return res.status(400).json({ok:false,error:'Note title is limited to 100 characters and note text to 50,000.'});
    try{
      const {data,error}=await supabaseAdmin.from('notes').insert({user_id:user.id,title,body}).select('id,title,updated_at').single();
      if(error)throw error;await audit(user.id,'note_created',title);
      return res.status(201).json({ok:true,note:{id:data.id,title:data.title,updated:data.updated_at}});
    }catch(error){return fail(res,error,'Could not create this note.')}
  });

  app.put('/api/notes',rateLimit(120,10*60*1000),async(req,res)=>{
    const user=await requireOwner(req,res);if(!user)return;
    const id=String(req.body?.id||''),title=typeof req.body?.title==='string'?req.body.title.trim()||'Untitled note':'Untitled note',body=typeof req.body?.text==='string'?req.body.text:'';
    if(!uuid.test(id))return res.status(400).json({ok:false,error:'Choose a valid note.'});
    if(title.length>100||body.length>50000)return res.status(400).json({ok:false,error:'Note title is limited to 100 characters and note text to 50,000.'});
    try{
      const {data:current,error:readError}=await supabaseAdmin.from('notes').select('id,title,body').eq('id',id).eq('user_id',user.id).maybeSingle();
      if(readError)throw readError;if(!current)return res.status(404).json({ok:false,error:'This note was not found.'});
      if(current.title!==title||current.body!==body){
        const {error:versionError}=await supabaseAdmin.from('note_versions').insert({user_id:user.id,note_id:id,title:current.title,body:current.body});
        if(versionError)throw versionError;
        const {error:trimError}=await supabaseAdmin.from('note_versions').delete().eq('note_id',id).eq('user_id',user.id).lt('saved_at',new Date(Date.now()-90*24*60*60*1000).toISOString());
        if(trimError)throw trimError;
      }
      const {data,error}=await supabaseAdmin.from('notes').update({title,body,updated_at:new Date().toISOString()}).eq('id',id).eq('user_id',user.id).select('updated_at').single();
      if(error)throw error;await audit(user.id,'note_updated',title);
      return res.json({ok:true,updated:data.updated_at});
    }catch(error){return fail(res,error,'Could not save this note.')}
  });

  app.get('/api/notes/history',rateLimit(60,60*1000),async(req,res)=>{
    const user=await requireOwner(req,res);if(!user)return;
    const id=String(req.query.id||'');if(!uuid.test(id))return res.status(400).json({ok:false,error:'Choose a valid note.'});
    try{
      const {data:note,error:noteError}=await supabaseAdmin.from('notes').select('id').eq('id',id).eq('user_id',user.id).maybeSingle();
      if(noteError)throw noteError;if(!note)return res.status(404).json({ok:false,error:'This note was not found.'});
      const {data,error}=await supabaseAdmin.from('note_versions').select('id,title,body,saved_at').eq('note_id',id).eq('user_id',user.id).order('saved_at',{ascending:false}).limit(100);
      if(error)throw error;return res.json({ok:true,history:(data||[]).map(v=>({id:v.id,title:v.title,text:v.body,savedAt:v.saved_at}))});
    }catch(error){return fail(res,error,'Could not load note history.')}
  });

  app.delete('/api/notes',rateLimit(30,10*60*1000),async(req,res)=>{
    const user=await requireOwner(req,res);if(!user)return;
    const id=String(req.query.id||'');if(!uuid.test(id))return res.status(400).json({ok:false,error:'Choose a valid note.'});
    try{
      const {data,error}=await supabaseAdmin.from('notes').delete().eq('id',id).eq('user_id',user.id).select('id').maybeSingle();
      if(error)throw error;if(!data)return res.status(404).json({ok:false,error:'This note was not found.'});
      await audit(user.id,'note_deleted',id);return res.json({ok:true});
    }catch(error){return fail(res,error,'Could not delete this note.')}
  });

  app.get('/api/security/events',rateLimit(60,60*1000),async(req,res)=>{
    const user=await requireOwner(req,res);if(!user)return;
    try{
      const {data,error}=await supabaseAdmin.from('security_events').select('event_type,device_label,created_at').eq('user_id',user.id).order('created_at',{ascending:false}).limit(500);
      if(error)throw error;
      const events=(data||[]).map(e=>({action:e.event_type,actor:e.device_label||'PhoneBridge',at:e.created_at}));
      return res.json({ok:true,events,retained:events.length,limit:500});
    }catch(error){return fail(res,error,'Could not load security activity.')}
  });
  return {recordSecurityEvent:audit};
}
module.exports={installWorkspaceRoutes};
