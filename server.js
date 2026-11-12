'use strict';
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const app = express();
const port = Number(process.env.PORT || 3000);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use((req,res,next)=>{
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  next();
});
app.get('/health',(req,res)=>res.status(200).json({ok:true,service:'Phone Bridge Cloud',version:'1.0.0'}));
app.get('/config',(req,res)=>{
  const url=process.env.SUPABASE_URL||'';
  const key=process.env.SUPABASE_ANON_KEY||'';
  if(!url||!key||url.includes('YOUR_PROJECT'))return res.status(503).json({ready:false,message:'Cloud authentication is not configured yet.'});
  res.setHeader('Cache-Control','no-store');
  res.json({ready:true,supabaseUrl:url,supabaseAnonKey:key});
});
app.use(express.static(path.join(__dirname,'public'),{extensions:['html'],maxAge:process.env.NODE_ENV==='production'?'1h':0}));
app.get(/.*/,(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(port,'0.0.0.0',()=>console.log('Phone Bridge Cloud listening on '+port));
