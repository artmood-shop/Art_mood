const express = require("express");
const crypto = require("crypto");
const ZarinpalPayment = require("zarinpal-pay");

const app = express();
app.use(express.json());
app.use(express.static("public"));
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const MERCHANT = process.env.ZARINPAL_MERCHANT_ID || "";
const SANDBOX = process.env.ZARINPAL_SANDBOX === "true";
const IS_TOMAN = process.env.ZARINPAL_IS_TOMAN !== "false";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me-now";

const zarinpal = MERCHANT ? new ZarinpalPayment(MERCHANT,{isSandbox:SANDBOX,isToman:IS_TOMAN}) : null;

const products = new Map([
 ["quiet-shapes",{id:"quiet-shapes",name:"Quiet Shapes",price:1850000,desc:"تابلو مینیمال دست‌ساز",stock:3,active:true,cls:"p1"}],
 ["soft-morning",{id:"soft-morning",name:"Soft Morning",price:2100000,desc:"ترکیب رنگ آرام و مدرن",stock:5,active:true,cls:"p2"}],
 ["night-muse",{id:"night-muse",name:"Night Muse",price:2350000,desc:"اثر انتزاعی معاصر",stock:2,active:true,cls:"p3"}]
]);
const orders = new Map();
const sessions = new Set();

function makeId(){return "AM-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(3).toString("hex").toUpperCase();}
function admin(req,res,next){
 const token=req.headers.authorization?.replace(/^Bearer\s+/,"");
 if(!token || !sessions.has(token)) return res.status(401).json({error:"نیاز به ورود مدیر است."});
 next();
}
function publicProducts(){return [...products.values()].filter(p=>p.active).map(({id,name,price,desc,stock,cls})=>({id,name,price,desc,stock,cls}));}

app.get("/api/products",(req,res)=>res.json(publicProducts()));

app.post("/api/admin/login",(req,res)=>{
 if(req.body?.password !== ADMIN_PASSWORD) return res.status(401).json({error:"رمز عبور نادرست است."});
 const token=crypto.randomBytes(32).toString("hex"); sessions.add(token); res.json({token});
});
app.post("/api/admin/logout",admin,(req,res)=>{const t=req.headers.authorization.replace(/^Bearer\s+/,"");sessions.delete(t);res.json({ok:true});});
app.get("/api/admin/dashboard",admin,(req,res)=>{
 const all=[...orders.values()];
 res.json({
  products:[...products.values()],
  orders:all.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),
  stats:{
   totalOrders:all.length,
   paidOrders:all.filter(o=>o.status==="paid").length,
   revenue:all.filter(o=>o.status==="paid").reduce((s,o)=>s+o.total,0),
   lowStock:[...products.values()].filter(p=>p.stock<=2).length
  }
 });
});
app.post("/api/admin/products",admin,(req,res)=>{
 const {id,name,price,desc,stock,active=true,cls="p1"}=req.body||{};
 if(!id||!name||!Number.isFinite(+price)) return res.status(400).json({error:"اطلاعات محصول ناقص است."});
 products.set(id,{id,name,price:+price,desc:desc||"",stock:Math.max(0,+stock||0),active:Boolean(active),cls});
 res.json(products.get(id));
});
app.patch("/api/admin/products/:id",admin,(req,res)=>{
 const p=products.get(req.params.id); if(!p)return res.status(404).json({error:"محصول پیدا نشد."});
 Object.assign(p,req.body);
 if(req.body.price!==undefined)p.price=+req.body.price;
 if(req.body.stock!==undefined)p.stock=Math.max(0,+req.body.stock);
 products.set(p.id,p);res.json(p);
});
app.delete("/api/admin/products/:id",admin,(req,res)=>{
 const p=products.get(req.params.id);if(!p)return res.status(404).json({error:"محصول پیدا نشد."});
 p.active=false;products.set(p.id,p);res.json({ok:true});
});

app.post("/api/orders",async(req,res)=>{
 try{
  const {items,customer}=req.body;
  if(!Array.isArray(items)||!items.length)return res.status(400).json({error:"سبد خرید خالی است."});
  if(!customer?.name||!customer?.phone||!customer?.address)return res.status(400).json({error:"نام، موبایل و آدرس الزامی است."});
  const normalized=items.map(x=>{
   const p=products.get(x.id); if(!p||!p.active)throw new Error("محصول نامعتبر است.");
   const qty=Math.max(1,Math.min(p.stock,Number(x.qty)||1)); if(qty<1)throw new Error("موجودی محصول کافی نیست.");
   return {id:p.id,name:p.name,price:p.price,qty};
  });
  const total=normalized.reduce((s,x)=>s+x.price*x.qty,0),id=makeId();
  const order={id,items:normalized,total,customer,status:"pending_payment",createdAt:new Date().toISOString()};
  orders.set(id,order);
  if(!zarinpal)return res.json({orderId:id,demo:true,message:"درگاه پیکربندی نشده است."});
  const tx=await zarinpal.create({amount:total,callback_url:`${BASE_URL}/api/payment/callback`,mobile:customer.phone,email:customer.email||undefined,description:`Art Mood ${id}`,order_id:id});
  if(!tx||tx.code!==100){order.status="payment_creation_failed";return res.status(502).json({error:"ایجاد تراکنش ناموفق بود."});}
  order.authority=tx.authority;orders.set(id,order);res.json({orderId:id,paymentUrl:tx.link});
 }catch(e){res.status(400).json({error:e.message||"خطا در ثبت سفارش"});}
});
app.get("/api/payment/callback",async(req,res)=>{
 const {Authority,Status}=req.query;const order=[...orders.values()].find(o=>o.authority===Authority);
 if(!order)return res.redirect(`${BASE_URL}/?payment=failed&reason=order_not_found`);
 if(Status!=="OK"){order.status="payment_failed";return res.redirect(`${BASE_URL}/?payment=failed&order=${encodeURIComponent(order.id)}`);}
 try{
  const result=await zarinpal.verify({authority:Authority,amount:order.total});
  if(result?.code===100||result?.code===101){
   order.status="paid";order.refId=result.ref_id||null;order.paidAt=new Date().toISOString();
   for(const item of order.items){const p=products.get(item.id);if(p)p.stock=Math.max(0,p.stock-item.qty);}
   return res.redirect(`${BASE_URL}/?payment=success&order=${encodeURIComponent(order.id)}&ref=${encodeURIComponent(order.refId||"")}`);
  }
  order.status="payment_failed";res.redirect(`${BASE_URL}/?payment=failed&order=${encodeURIComponent(order.id)}`);
 }catch(e){order.status="verification_error";res.redirect(`${BASE_URL}/?payment=failed&order=${encodeURIComponent(order.id)}&reason=verification`);}
});
app.get("/api/orders/:id",(req,res)=>{const o=orders.get(req.params.id);if(!o)return res.status(404).json({error:"سفارش پیدا نشد."});res.json({id:o.id,status:o.status,total:o.total,items:o.items,refId:o.refId||null});});
app.patch("/api/admin/orders/:id",admin,(req,res)=>{const o=orders.get(req.params.id);if(!o)return res.status(404).json({error:"سفارش پیدا نشد."});if(req.body.status)o.status=req.body.status;orders.set(o.id,o);res.json(o);});

app.listen(PORT,()=>console.log(`Art Mood running on ${PORT}`));
