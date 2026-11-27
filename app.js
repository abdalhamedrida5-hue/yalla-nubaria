/* يلا نوبارية - منطق التطبيق */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var APP_NAME = CFG.APP_NAME || 'يلا نوبارية';
  var sb = null;
  var configured = CFG.SUPABASE_URL && CFG.SUPABASE_URL.indexOf('PASTE_') !== 0;

  if (configured && window.supabase) {
    sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  }

  // ---------- حالة عامة ----------
  var session = null;
  var profile = null;
  var myShop = null; // لو المستخدم محل
  var cart = null;   // {shopId, shopName, deliveryFee, items:{pid:{id,name,price,qty}}}
  var pollTimer = null;

  var STATUS = {
    'new': 'جديد 🟡',
    'confirmed': 'المحل أكده 🔵',
    'picked_up': 'مع الكابتن 🛵',
    'delivered': 'اتسلّم ✅',
    'cancelled': 'ملغي ❌'
  };

  var CATEGORIES = ['مطعم', 'سوبرماركت', 'صيدلية', 'مخبز', 'خضار وفاكهة', 'كشري ووجبات', 'قهوة وعصائر', 'أخرى'];
  var VEHICLES = ['موتوسيكل', 'تكتك', 'عربية', 'دراجة', 'مشي'];

  // ---------- أدوات ----------
  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    var v = Math.round(Number(n) * 100) / 100;
    return (v % 1 === 0 ? v : v.toFixed(2)) + ' جنيه';
  }
  function phoneOk(p) { return /^01[0125]\d{8}$/.test(p); }
  function phoneToEmail(p) { return p + '@yallanubaria.app'; }
  function waLink(phone, text) {
    var intl = phone;
    if (/^01\d{9}$/.test(phone)) intl = '2' + phone;
    return 'https://wa.me/' + intl + (text ? '?text=' + encodeURIComponent(text) : '');
  }
  function go(hash) { location.hash = hash; }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function startPoll(fn) { stopPoll(); pollTimer = setInterval(fn, 15000); }
  function showErr(msg) {
    var app = $('#app');
    var d = document.createElement('div');
    d.className = 'notice err';
    d.textContent = msg;
    app.prepend(d);
    setTimeout(function () { d.remove(); }, 5000);
  }

  // ---------- جلسة ----------
  async function loadSession() {
    if (!sb) return;
    var r = await sb.auth.getSession();
    session = r.data.session;
    if (session) await loadProfile();
  }
  async function loadProfile() {
    var r = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    profile = r.data || null;
    myShop = null;
    if (profile && profile.role === 'shop') {
      var s = await sb.from('shops').select('*').eq('owner_id', profile.id).maybeSingle();
      myShop = s.data || null;
    }
  }

  function renderNav() {
    var nav = $('#topnav');
    var h = '';
    if (!profile) {
      h += '<button data-go="#/login">دخول</button>';
    } else {
      if (profile.role === 'customer') {
        h += '<button data-go="#/shops">المحلات</button><button data-go="#/orders">طلباتي</button>';
      } else if (profile.role === 'shop') {
        h += '<button data-go="#/dashboard">محلي</button>';
      } else if (profile.role === 'captain') {
        h += '<button data-go="#/captain">الطلبات</button>';
      } else if (profile.role === 'admin') {
        h += '<button data-go="#/admin">لوحة التحكم</button>';
      }
      if (profile.role !== 'admin') {
        h += '<button data-go="#/wallet">محفظتي 💰</button>';
      }
      h += '<button id="btn-logout">خروج</button>';
    }
    nav.innerHTML = h;
    nav.querySelectorAll('[data-go]').forEach(function (b) {
      b.onclick = function () { go(b.getAttribute('data-go')); };
    });
    var lo = $('#btn-logout');
    if (lo) lo.onclick = async function () { stopPoll(); await sb.auth.signOut(); session = null; profile = null; cart = null; go(''); render(); };
  }

  // ---------- عرض ----------
  function setMain(html) { $('#app').innerHTML = html; }

  function render() {
    stopPoll();
    renderNav();
    var hash = location.hash || '';

    if (!configured) return vSetup();
    if (!session || !profile) {
      if (hash.indexOf('#/signup') === 0) return vSignup(hash.split('/')[2] || 'customer');
      if (hash === '#/login') return vLogin();
      return vLanding();
    }
    if (profile.status === 'pending') return vPending();
    if (profile.status === 'rejected') return vRejected();

    if (hash === '#/claim') return vClaimAdmin();
    if (hash === '#/shops') return vShops();
    if (hash.indexOf('#/shop/') === 0) return vShopDetail(hash.split('/')[2]);
    if (hash === '#/checkout') return vCheckout();
    if (hash === '#/orders') return vMyOrders();
    if (hash === '#/dashboard') return profile.role === 'shop' ? vShopDash('orders') : go('');
    if (hash === '#/dashboard/products') return profile.role === 'shop' ? vShopDash('products') : go('');
    if (hash === '#/dashboard/settings') return profile.role === 'shop' ? vShopDash('settings') : go('');
    if (hash === '#/captain') return profile.role === 'captain' ? vCaptain() : go('');
    if (hash === '#/admin') return profile.role === 'admin' ? vAdmin('approvals') : go('');
    if (hash === '#/admin/orders') return profile.role === 'admin' ? vAdmin('orders') : go('');
    if (hash === '#/admin/wallets') return profile.role === 'admin' ? vAdmin('wallets') : go('');
    if (hash === '#/wallet') return profile.role === 'admin' ? go('') : vWallet();

    // افتراضي حسب الدور
    if (profile.role === 'customer') return go('#/shops');
    if (profile.role === 'shop') return go('#/dashboard');
    if (profile.role === 'captain') return go('#/captain');
    if (profile.role === 'admin') return go('#/admin');
  }

  function vSetup() {
    setMain(
      '<div class="hero"><h1>' + esc(APP_NAME) + ' 🛵</h1><p>التطبيق لسه محتاج ربط قاعدة البيانات</p></div>' +
      '<div class="notice warn">النسخة دي لسه متوصلتش بقاعدة البيانات (Supabase). لو إنت صاحب التطبيق: نفّذ خطوات ملف README-SETUP وبعدها حدّث ملف config.js.</div>'
    );
  }

  function vLanding() {
    setMain(
      '<div class="hero"><h1>' + esc(APP_NAME) + ' 🛵</h1>' +
      '<p>اطلب من محلات مدينة النوبارية… وكابتن يوصّللك لحد باب البيت</p></div>' +
      '<div class="role-grid">' +
      '<div class="role-card" data-role="customer"><span class="emoji">🧺</span><b>زبون</b><div class="muted">عايز تطلب</div></div>' +
      '<div class="role-card" data-role="shop"><span class="emoji">🏪</span><b>محل</b><div class="muted">عندك محل</div></div>' +
      '<div class="role-card" data-role="captain"><span class="emoji">🛵</span><b>كابتن</b><div class="muted">عايز توصّل</div></div>' +
      '</div>' +
      '<div class="center"><button class="linklike" id="to-login">عندك حساب؟ ادخل من هنا</button></div>' +
      '<div class="center" style="margin-top:18px"><button class="linklike" id="claim-admin" style="color:#aaa;font-size:.75rem">أنا صاحب التطبيق</button></div>'
    );
    document.querySelectorAll('.role-card').forEach(function (c) {
      c.onclick = function () { go('#/signup/' + c.getAttribute('data-role')); };
    });
    $('#to-login').onclick = function () { go('#/login'); };
    $('#claim-admin').onclick = function () {
      if (!session) { showErr('سجّل دخولك الأول وبعدين اضغط هنا'); return; }
      go('#/claim');
    };
  }

  function vLogin() {
    setMain(
      '<div class="card"><h3>تسجيل الدخول</h3>' +
      '<label>رقم الموبايل</label><input id="f-phone" inputmode="numeric" placeholder="01xxxxxxxxx" maxlength="11">' +
      '<label>كلمة السر</label><input id="f-pass" type="password" placeholder="كلمة السر">' +
      '<button class="btn" id="do-login">دخول</button>' +
      '<hr class="divider"><div class="center"><button class="linklike" id="to-signup">ماعندكش حساب؟ سجّل من هنا</button></div></div>'
    );
    $('#to-signup').onclick = function () { go(''); };
    $('#do-login').onclick = async function () {
      var phone = $('#f-phone').value.trim(), pass = $('#f-pass').value;
      if (!phoneOk(phone)) return showErr('اكتب رقم موبايل مصري صح (11 رقم يبدأ بـ 01)');
      if (!pass) return showErr('اكتب كلمة السر');
      $('#do-login').disabled = true;
      var r = await sb.auth.signInWithPassword({ email: phoneToEmail(phone), password: pass });
      $('#do-login').disabled = false;
      if (r.error) return showErr('الرقم أو كلمة السر غلط');
      session = r.data.session;
      await loadProfile();
      if (!profile) return showErr('الحساب ده مالوش بيانات، سجّل من جديد');
      go(''); render();
    };
  }

  function vSignup(role) {
    var roleName = { customer: 'زبون', shop: 'محل', captain: 'كابتن' }[role] || 'زبون';
    var extra = '';
    if (role === 'shop') {
      extra =
        '<label>اسم المحل</label><input id="f-shopname" placeholder="مثال: سوبر ماركت النور">' +
        '<label>نوع المحل</label><select id="f-cat">' + CATEGORIES.map(function (c) { return '<option>' + c + '</option>'; }).join('') + '</select>' +
        '<label>عنوان المحل</label><input id="f-address" placeholder="الشارع / المنطقة">' +
        '<label>سعر التوصيل (جنيه)</label><input id="f-fee" inputmode="decimal" value="15">';
    } else if (role === 'captain') {
      extra =
        '<label>وسيلة التوصيل</label><select id="f-vehicle">' + VEHICLES.map(function (v) { return '<option>' + v + '</option>'; }).join('') + '</select>';
    }
    var note = role === 'customer' ? '' :
      '<div class="notice warn">حسابك هيستنى موافقة إدارة التطبيق قبل ما يشتغل.</div>';
    setMain(
      '<div class="card"><h3>حساب جديد - ' + roleName + '</h3>' + note +
      '<label>الاسم</label><input id="f-name" placeholder="اسمك الكامل">' +
      '<label>رقم الموبايل</label><input id="f-phone" inputmode="numeric" placeholder="01xxxxxxxxx" maxlength="11">' +
      '<label>كلمة السر (6 حروف أو أكتر)</label><input id="f-pass" type="password" placeholder="كلمة السر">' +
      extra +
      '<button class="btn" id="do-signup">تسجيل</button>' +
      '<hr class="divider"><div class="center"><button class="linklike" id="to-login">عندك حساب؟ ادخل</button></div></div>'
    );
    $('#to-login').onclick = function () { go('#/login'); };
    $('#do-signup').onclick = async function () {
      var name = $('#f-name').value.trim(), phone = $('#f-phone').value.trim(), pass = $('#f-pass').value;
      if (name.length < 2) return showErr('اكتب اسمك');
      if (!phoneOk(phone)) return showErr('اكتب رقم موبايل مصري صح (11 رقم يبدأ بـ 01)');
      if (pass.length < 6) return showErr('كلمة السر لازم 6 حروف أو أكتر');
      var payload = { name: name, phone: phone, pass: pass };
      if (role === 'shop') {
        payload.shopName = $('#f-shopname').value.trim();
        payload.cat = $('#f-cat').value;
        payload.address = $('#f-address').value.trim();
        payload.fee = parseFloat($('#f-fee').value) || 15;
        if (!payload.shopName) return showErr('اكتب اسم المحل');
      }
      if (role === 'captain') payload.vehicle = $('#f-vehicle').value;

      $('#do-signup').disabled = true;
      var r = await sb.auth.signUp({ email: phoneToEmail(phone), password: pass });
      if (r.error) { $('#do-signup').disabled = false; return showErr(r.error.message.indexOf('already') >= 0 ? 'الرقم ده متسجل قبل كده، جرّب تدخل' : r.error.message); }
      var user = r.data.user;
      if (!r.data.session) {
        var li = await sb.auth.signInWithPassword({ email: phoneToEmail(phone), password: pass });
        if (li.error) { $('#do-signup').disabled = false; return showErr('اتسجل الحساب بس محتاج تفعيل، كلم إدارة التطبيق'); }
        session = li.data.session;
      } else {
        session = r.data.session;
      }
      var pr = await sb.from('profiles').insert({
        id: user.id, full_name: name, phone: phone, role: role,
        status: role === 'customer' ? 'approved' : 'pending',
        vehicle: payload.vehicle || null
      });
      if (pr.error) { $('#do-signup').disabled = false; return showErr('حصل خطأ فى حفظ البيانات: ' + pr.error.message); }
      if (role === 'shop') {
        var sr = await sb.from('shops').insert({
          owner_id: user.id, name: payload.shopName, category: payload.cat,
          address: payload.address, phone: phone, delivery_fee: payload.fee
        });
        if (sr.error) { $('#do-signup').disabled = false; return showErr('حصل خطأ فى حفظ المحل: ' + sr.error.message); }
      }
      await loadProfile();
      go(''); render();
    };
  }

  function vPending() {
    setMain(
      '<div class="hero"><h1>⏳ مستني الموافقة</h1></div>' +
      '<div class="notice warn">حسابك اتسجل بنجاح ومستني موافقة إدارة التطبيق. هتقدر تشتغل أول ما يوافقوا عليك.</div>' +
      '<div class="center"><button class="btn ghost small" id="refresh-st">تحقق تاني</button></div>'
    );
    $('#refresh-st').onclick = async function () { await loadProfile(); render(); };
  }

  async function vClaimAdmin() {
    setMain('<div class="card"><h3>تفعيل صلاحية الأدمن</h3>' +
      '<div class="muted" style="margin-bottom:8px">لو انت صاحب التطبيق وسجّلت برقمك المعتمد، اضغط تفعيل. لو معاك كود التفعيل اكتبه.</div>' +
      '<label>كود التفعيل (اختياري لرقم صاحب التطبيق)</label><input id="c-code" placeholder="مثال: XX-0000-XX">' +
      '<button class="btn" id="do-claim">تفعيل</button></div>');
    $('#do-claim').onclick = async function () {
      setMain('<div class="loading">جاري التحقق…</div>');
      var code = ($('#c-code') && $('#c-code').value ? $('#c-code').value.trim() : '') || null;
      var r = await sb.rpc('claim_admin', { p_code: code });
      if (r.error) { setMain('<div class="notice err">حصل خطأ: ' + esc(r.error.message) + '</div>'); return; }
      if (r.data === 'ok') {
        await loadProfile();
        setMain('<div class="notice ok">تمام ✅ بقيت أدمن التطبيق</div>');
        setTimeout(function () { go(''); render(); }, 1200);
      } else if (r.data === 'wrong_code') {
        setMain('<div class="notice err">الكود غلط. صلاحية الأدمن لصاحب التطبيق بس.</div>');
      } else {
        setMain('<div class="notice err">فيه أدمن متسجل قبل كده</div>');
      }
    };
  }

  function vRejected() {
    setMain('<div class="hero"><h1>🚫 الحساب مترفض</h1></div><div class="notice err">إدارة التطبيق رفضت الحساب ده. لو فيه لبس، كلم إدارة يلا نوبارية.</div>');
  }

  // ---------- زبون ----------
  async function vShops() {
    setMain('<div class="loading">جاري تحميل المحلات…</div>');
    var r = await sb.from('shops').select('*').eq('is_open', true).order('name');
    if (r.error) return showErr(r.error.message);
    var shops = (r.data || []).filter(function (s) { return s.owner_id !== profile.id; });
    if (!shops.length) {
      setMain('<div class="hero"><h1>🏪 المحلات</h1><p>لسه مفيش محلات متاحة، ارجع بعدين</p></div>');
      return;
    }
    setMain('<h3 style="margin-bottom:10px">اطلب من:</h3>' + shops.map(function (s) {
      return '<div class="card" data-shop="' + s.id + '" style="cursor:pointer">' +
        '<div class="row"><div class="grow"><h3>' + esc(s.name) + '</h3>' +
        '<div class="muted">' + esc(s.category) + (s.address ? ' • ' + esc(s.address) : '') + '</div>' +
        '<div class="muted">توصيل: ' + money(s.delivery_fee) + '</div></div><div style="font-size:1.6rem">🏪</div></div></div>';
    }).join(''));
    document.querySelectorAll('[data-shop]').forEach(function (c) {
      c.onclick = function () { go('#/shop/' + c.getAttribute('data-shop')); };
    });
  }

  async function vShopDetail(id) {
    setMain('<div class="loading">جاري التحميل…</div>');
    var sr = await sb.from('shops').select('*').eq('id', id).single();
    if (sr.error || !sr.data) return setMain('<div class="notice err">المحل ده مش موجود</div>');
    var shop = sr.data;
    var pr = await sb.from('products').select('*').eq('shop_id', id).eq('is_available', true).order('name');
    var products = pr.data || [];

    if (cart && cart.shopId !== id) cart = null;
    if (!cart) cart = { shopId: id, shopName: shop.name, deliveryFee: shop.delivery_fee, items: {} };

    var h = '<button class="linklike" id="back">← رجوع للمحلات</button>' +
      '<div class="card"><div class="row"><div class="grow"><h3>' + esc(shop.name) + '</h3>' +
      '<div class="muted">' + esc(shop.category) + (shop.address ? ' • ' + esc(shop.address) : '') + '</div></div>' +
      '<a class="wa" target="_blank" href="' + waLink(shop.phone, 'سلام، عندي استفسار عن ' + shop.name) + '">واتساب المحل</a></div></div>';

    if (!products.length) h += '<div class="notice warn">المحل ده لسه مضافش منتجاته</div>';
    h += products.map(function (p) {
      var inCart = cart.items[p.id];
      return '<div class="card"><div class="row">' +
        '<div class="grow"><b>' + esc(p.name) + '</b><div class="muted">' + money(p.price) + '</div></div>' +
        (inCart
          ? '<div class="qty-ctrl"><button class="minus" data-dec="' + p.id + '">−</button><b>' + inCart.qty + '</b><button data-inc="' + p.id + '">+</button></div>'
          : '<button class="btn small" data-add="' + p.id + '">أضف</button>') +
        '</div></div>';
    }).join('');

    var count = cartCount();
    if (count > 0) {
      h += '<div class="cart-bar" id="go-checkout"><div>🧺 ' + count + ' صنف</div><b>' + money(cartSubtotal() + cart.deliveryFee) + ' ← إتمام الطلب</b></div>';
    }
    setMain(h);

    $('#back').onclick = function () { go('#/shops'); };
    products.forEach(function (p) {
      var add = document.querySelector('[data-add="' + p.id + '"]');
      if (add) add.onclick = function () { cart.items[p.id] = { id: p.id, name: p.name, price: p.price, qty: 1 }; saveCart(); render(); };
      var inc = document.querySelector('[data-inc="' + p.id + '"]');
      if (inc) inc.onclick = function () { cart.items[p.id].qty++; saveCart(); render(); };
      var dec = document.querySelector('[data-dec="' + p.id + '"]');
      if (dec) dec.onclick = function () {
        cart.items[p.id].qty--;
        if (cart.items[p.id].qty <= 0) delete cart.items[p.id];
        saveCart(); render();
      };
    });
    var gc = $('#go-checkout');
    if (gc) gc.onclick = function () { go('#/checkout'); };
  }

  function cartCount() {
    if (!cart) return 0;
    return Object.keys(cart.items).reduce(function (n, k) { return n + cart.items[k].qty; }, 0);
  }
  function cartSubtotal() {
    return Object.keys(cart.items).reduce(function (n, k) { return n + cart.items[k].qty * cart.items[k].price; }, 0);
  }
  function saveCart() { try { localStorage.setItem('yn_cart', JSON.stringify(cart)); } catch (e) {} }
  function loadCart() { try { cart = JSON.parse(localStorage.getItem('yn_cart')); } catch (e) { cart = null; } }

  async function vCheckout() {
    if (!cart || cartCount() === 0) { go('#/shops'); return; }
    var items = Object.keys(cart.items).map(function (k) { return cart.items[k]; });
    var sub = cartSubtotal(), fee = cart.deliveryFee, total = sub + fee;
    setMain(
      '<button class="linklike" id="back">← رجوع</button>' +
      '<div class="card"><h3>إتمام الطلب من ' + esc(cart.shopName) + '</h3>' +
      items.map(function (i) { return '<div class="total-line"><span>' + esc(i.name) + ' × ' + i.qty + '</span><span>' + money(i.qty * i.price) + '</span></div>'; }).join('') +
      '<div class="total-line"><span>التوصيل</span><span>' + money(fee) + '</span></div>' +
      '<div class="total-line grand"><span>الإجمالي</span><span>' + money(total) + '</span></div>' +
      '<div class="total-line"><span>طريقة الدفع</span><b>كاش عند الاستلام 💵</b></div>' +
      '</div>' +
      '<div class="notice ok">هتدفع ' + money(total) + ' كاش للكابتن لما يوصّلك الطلب.</div>' +
      '<div class="card">' +
      '<label>العنوان بالتفصيل</label><textarea id="f-addr" rows="2" placeholder="الشارع، رقم العمارة، علامة مميزة…"></textarea>' +
      '<label>موبايل للتواصل</label><input id="f-phone" inputmode="numeric" maxlength="11" value="' + esc(profile.phone) + '">' +
      '<label>ملاحظات (اختياري)</label><input id="f-notes" placeholder="مثال: من غير بصل">' +
      '<button class="btn" id="place-order">تأكيد الطلب - ' + money(total) + '</button>' +
      '</div>'
    );
    $('#back').onclick = function () { go('#/shop/' + cart.shopId); };
    var po = $('#place-order');
    if (!po) return;
    po.onclick = async function () {
      var addr = $('#f-addr').value.trim(), phone = $('#f-phone').value.trim(), notes = $('#f-notes').value.trim();
      if (addr.length < 5) return showErr('اكتب العنوان بالتفصيل');
      if (!phoneOk(phone)) return showErr('رقم الموبايل مش صح');
      po.disabled = true;
      var or = await sb.from('orders').insert({
        customer_id: profile.id, shop_id: cart.shopId,
        delivery_address: addr, customer_phone: phone, notes: notes,
        subtotal: sub, delivery_fee: fee, total: total, payment_method: 'cash'
      }).select('id').single();
      if (or.error) {
        po.disabled = false;
        return showErr('الطلب متبعتش: ' + or.error.message);
      }
      var orderId = or.data.id;
      var ir = await sb.from('order_items').insert(items.map(function (i) {
        return { order_id: orderId, product_id: i.id, name: i.name, price: i.price, qty: i.qty };
      }));
      if (ir.error) { po.disabled = false; return showErr('حصل خطأ فى الأصناف: ' + ir.error.message); }
      cart = null; saveCart();
      setMain(
        '<div class="hero"><h1>✅ طلبك اتبعت!</h1><p>المحل هيراجع الطلب ويأكده، والكابتن هيوصّله</p></div>' +
        '<div class="notice ok">هتدفع ' + money(total) + ' كاش للكابتن عند الاستلام 💵</div>' +
        '<button class="btn" id="to-orders">تابع طلبك</button>'
      );
      $('#to-orders').onclick = function () { go('#/orders'); };
    };
  }

  async function myBalance() {
    var r = await sb.rpc('my_balance');
    if (r.error) return null;
    return Number(r.data) || 0;
  }

  async function vMyOrders() {
    setMain('<div class="loading">جاري تحميل طلباتك…</div>');
    var r = await sb.from('orders').select('*, shops(name)').eq('customer_id', profile.id).order('created_at', { ascending: false }).limit(30);
    if (r.error) return showErr(r.error.message);
    var orders = r.data || [];
    if (!orders.length) {
      setMain('<div class="hero"><h1>🧺 طلباتي</h1><p>لسه ماطلبتش حاجة</p></div><button class="btn" id="go-shops">اطلب دلوقتي</button>');
      $('#go-shops').onclick = function () { go('#/shops'); };
      return;
    }
    setMain('<h3 style="margin-bottom:10px">طلباتي</h3>' + orders.map(function (o) {
      return '<div class="card"><div class="row"><div class="grow">' +
        '<b>' + esc(o.shops ? o.shops.name : '') + '</b> <span class="badge ' + o.status + '">' + (STATUS[o.status] || o.status) + '</span>' +
        '<div class="muted">' + money(o.total) + ' • ' + (o.payment_method === 'wallet' ? 'دفع من المحفظة' : 'كاش عند الاستلام') + ' • ' + new Date(o.created_at).toLocaleString('ar-EG') + '</div></div>' +
        (o.status === 'new' ? '<button class="btn small danger" data-cancel="' + o.id + '">إلغاء</button>' : '') +
        '</div></div>';
    }).join(''));
    orders.forEach(function (o) {
      var b = document.querySelector('[data-cancel="' + o.id + '"]');
      if (b) b.onclick = async function () {
        if (!confirm('متأكد إنك عايز تلغي الطلب؟')) return;
        var ur = await sb.from('orders').update({ status: 'cancelled' }).eq('id', o.id);
        if (ur.error) return showErr(ur.error.message);
        render();
      };
    });
    startPoll(function () { if ((location.hash || '') === '#/orders') vMyOrders(); });
  }

  // ---------- المحفظة ----------
  async function vWallet() {
    setMain('<div class="loading">جاري تحميل محفظتك…</div>');
    var bal = await myBalance();
    var lr = await sb.from('wallet_ledger').select('*').order('created_at', { ascending: false }).limit(30);
    var qr = await sb.from('wallet_requests').select('*').eq('status', 'pending').order('created_at', { ascending: false });
    var ledger = lr.data || [], reqs = qr.data || [];
    var KIND = {
      topup: 'شحن رصيد', withdrawal: 'سحب', order_payment: 'دفع طلب',
      order_refund: 'استرجاع طلب ملغي', order_earning: 'ربح من طلب',
      admin_adjustment: 'قيد يدوي من الإدارة'
    };
    var transferOn = !!CFG.WALLET_TRANSFER_ENABLED;
    var h = '<div class="hero"><h1>💰 محفظتي</h1>' +
      '<p style="font-size:1.6rem;margin:4px 0"><b>' + (bal === null ? '—' : money(bal)) + '</b></p></div>' +
      '<div class="notice warn">رصيدك ده سجل حسابات جوه التطبيق (مش حساب بنكي). الفلوس الحقيقية بتتدفع كاش عند الاستلام.</div>' +
      (transferOn ? '' : '<div class="notice warn">⏸️ الشحن والسحب متوقفين مؤقتاً لحد ما نراجع الترخيص. رصيدك وكل حركاتك محفوظين زي ما هما ومش هيتغيروا.</div>');

    h += reqs.map(function (q) {
      return '<div class="notice warn">⏳ طلب ' + (q.kind === 'topup' ? 'شحن' : 'سحب') + ' ' + money(q.amount) + ' مستني موافقة الإدارة</div>';
    }).join('');

    if (transferOn) {
    h += '<div class="card"><h3>شحن المحفظة</h3>' +
      '<div class="muted" style="margin-bottom:8px">حوّل المبلغ فودافون كاش أو إنستاباي على رقم الإدارة: <b>' + esc(CFG.ADMIN_PAY_PHONE || 'اسأل الإدارة') + '</b> وبعدين ابعت الطلب هنا، والإدارة هتأكد وتضيف الرصيد.</div>' +
      '<label>المبلغ (جنيه)</label><input id="w-topup-amt" inputmode="decimal" placeholder="مثال: 100">' +
      '<label>رقم العملية / وسيلة التحويل</label><input id="w-topup-note" placeholder="مثال: فودافون كاش عملية رقم 12345">' +
      '<button class="btn" id="w-topup">إرسال طلب شحن</button></div>';

    h += '<div class="card"><h3>سحب من المحفظة</h3>' +
      '<div class="muted" style="margin-bottom:8px">اطلب سحب والإدارة هتحوّللك فودافون كاش أو إنستاباي بعد المراجعة.</div>' +
      '<label>المبلغ (جنيه)</label><input id="w-wd-amt" inputmode="decimal" placeholder="مثال: 50">' +
      '<label>رقم استلام الفلوس</label><input id="w-wd-note" placeholder="رقم فودافون كاش / إنستاباي بتاعك">' +
      '<button class="btn" id="w-wd">إرسال طلب سحب</button></div>';
    }

    h += '<h3 style="margin:14px 0 8px">آخر الحركات</h3>';
    h += ledger.length ? ledger.map(function (l) {
      var pos = Number(l.amount) >= 0;
      return '<div class="card"><div class="row"><div class="grow">' +
        '<b>' + esc(KIND[l.kind] || l.kind) + '</b>' +
        (l.note ? '<div class="muted">' + esc(l.note) + '</div>' : '') +
        '<div class="muted">' + new Date(l.created_at).toLocaleString('ar-EG') + '</div></div>' +
        '<b style="color:' + (pos ? '#1a7f37' : '#b3261e') + '">' + (pos ? '+' : '') + money(l.amount) + '</b></div></div>';
    }).join('') : '<div class="notice warn">مفيش حركات لسه</div>';
    setMain(h);

    if ($('#w-topup')) $('#w-topup').onclick = async function () {
      var amt = parseFloat($('#w-topup-amt').value);
      if (!(amt > 0)) return showErr('اكتب مبلغ صح');
      $('#w-topup').disabled = true;
      var r = await sb.from('wallet_requests').insert({ user_id: profile.id, kind: 'topup', amount: amt, note: $('#w-topup-note').value.trim() });
      $('#w-topup').disabled = false;
      if (r.error) return showErr('الطلب متبعتش: ' + r.error.message);
      render();
    };
    if ($('#w-wd')) $('#w-wd').onclick = async function () {
      var amt = parseFloat($('#w-wd-amt').value);
      if (!(amt > 0)) return showErr('اكتب مبلغ صح');
      if (bal !== null && amt > bal) return showErr('المبلغ أكبر من رصيدك');
      $('#w-wd').disabled = true;
      var r = await sb.from('wallet_requests').insert({ user_id: profile.id, kind: 'withdrawal', amount: amt, note: $('#w-wd-note').value.trim() });
      $('#w-wd').disabled = false;
      if (r.error) return showErr('الطلب متبعتش: ' + r.error.message);
      render();
    };
  }

  // ---------- محل ----------
  async function vShopDash(tab) {
    if (!myShop) { setMain('<div class="loading">جاري التحميل…</div>'); await loadProfile(); if (!myShop) return setMain('<div class="notice err">مفيش محل مربوط بحسابك</div>'); }
    var tabs = '<div class="tabs">' +
      '<button data-tab="orders" class="' + (tab === 'orders' ? 'active' : '') + '>الطلبات</button>' +
      '<button data-tab="products" class="' + (tab === 'products' ? 'active' : '') + '>المنتجات</button>' +
      '<button data-tab="settings" class="' + (tab === 'settings' ? 'active' : '') + '>إعدادات</button></div>';
    var body = '<div class="loading">جاري التحميل…</div>';
    setMain(tabs + '<div id="tab-body">' + body + '</div>');
    document.querySelectorAll('.tabs button').forEach(function (b) {
      b.onclick = function () { go('#/dashboard' + (b.getAttribute('data-tab') === 'orders' ? '' : '/' + b.getAttribute('data-tab'))); };
    });
    var tb = $('#tab-body');

    if (tab === 'orders') {
      var r = await sb.from('orders').select('*, order_items(*)').eq('shop_id', myShop.id).order('created_at', { ascending: false }).limit(40);
      if (r.error) { tb.innerHTML = '<div class="notice err">' + esc(r.error.message) + '</div>'; return; }
      var orders = r.data || [];
      var active = orders.filter(function (o) { return o.status !== 'delivered' && o.status !== 'cancelled'; });
      var done = orders.filter(function (o) { return o.status === 'delivered' || o.status === 'cancelled'; }).slice(0, 10);
      var h = '';
      if (!active.length && !done.length) h = '<div class="notice warn">لسه مفيش طلبات. أضف منتجاتك من تبويب المنتجات عشان تظهر للزباين.</div>';
      if (active.length) {
        h += '<h3 style="margin:8px 0">طلبات شغالة</h3>' + active.map(function (o) {
          var items = (o.order_items || []).map(function (i) { return esc(i.name) + ' × ' + i.qty; }).join('، ');
          var btns = '';
          if (o.status === 'new') btns = '<button class="btn small" data-confirm="' + o.id + '">تأكيد</button> <button class="btn small danger" data-rej="' + o.id + '">رفض</button>';
          else if (o.status === 'confirmed') btns = '<span class="badge confirmed">مستني كابتن</span>';
          else if (o.status === 'picked_up') btns = '<span class="badge picked_up">مع الكابتن</span>';
          return '<div class="card"><div class="row"><div class="grow">' +
            '<span class="badge ' + o.status + '">' + (STATUS[o.status] || o.status) + '</span> <b>' + money(o.total) + '</b>' +
            '<div style="margin:6px 0">' + items + '</div>' +
            '<div class="muted">📍 ' + esc(o.delivery_address) + '</div>' +
            (o.notes ? '<div class="muted">📝 ' + esc(o.notes) + '</div>' : '') +
            '</div></div>' +
            '<div class="row" style="margin-top:8px">' + btns +
            '<a class="wa" target="_blank" href="' + waLink(o.customer_phone, 'بخصوص طلبك من ' + myShop.name) + '">واتساب الزبون</a></div></div>';
        }).join('');
      }
      if (done.length) {
        h += '<h3 style="margin:14px 0 8px">آخر الطلبات المنتهية</h3>' + done.map(function (o) {
          return '<div class="card"><div class="row"><div class="grow">' +
            '<span class="badge ' + o.status + '">' + (STATUS[o.status] || o.status) + '</span> <b>' + money(o.total) + '</b>' +
            '<div class="muted">' + new Date(o.created_at).toLocaleString('ar-EG') + '</div></div></div></div>';
        }).join('');
      }
      tb.innerHTML = h;
      active.forEach(function (o) {
        var c = document.querySelector('[data-confirm="' + o.id + '"]');
        if (c) c.onclick = async function () {
          var ur = await sb.from('orders').update({ status: 'confirmed' }).eq('id', o.id);
          if (ur.error) return showErr(ur.error.message);
          render();
        };
        var rj = document.querySelector('[data-rej="' + o.id + '"]');
        if (rj) rj.onclick = async function () {
          if (!confirm('متأكد إنك عايز ترفض الطلب؟')) return;
          var ur = await sb.from('orders').update({ status: 'cancelled' }).eq('id', o.id);
          if (ur.error) return showErr(ur.error.message);
          render();
        };
      });
      startPoll(function () { if ((location.hash || '') === '#/dashboard' || location.hash === '') vShopDash('orders'); });
    }

    if (tab === 'products') {
      var pr = await sb.from('products').select('*').eq('shop_id', myShop.id).order('created_at', { ascending: false });
      if (pr.error) { tb.innerHTML = '<div class="notice err">' + esc(pr.error.message) + '</div>'; return; }
      var products = pr.data || [];
      var h = '<div class="card"><h3>أضف منتج</h3>' +
        '<label>اسم المنتج</label><input id="p-name" placeholder="مثال: وجبة فراخ مشوية">' +
        '<label>السعر (جنيه)</label><input id="p-price" inputmode="decimal" placeholder="مثال: 65">' +
        '<button class="btn" id="p-add">إضافة</button></div>';
      h += products.length ? products.map(function (p) {
        return '<div class="card"><div class="row"><div class="grow">' +
          '<b>' + esc(p.name) + '</b> <span class="muted">' + money(p.price) + '</span>' +
          (p.is_available ? '' : ' <span class="badge cancelled">مخفي</span>') + '</div>' +
          '<button class="btn small ghost" data-toggle="' + p.id + '">' + (p.is_available ? 'إخفاء' : 'إظهار') + '</button> ' +
          '<button class="btn small danger" data-del="' + p.id + '">حذف</button></div></div>';
      }).join('') : '<div class="notice warn">مفيش منتجات لسه</div>';
      tb.innerHTML = h;
      $('#p-add').onclick = async function () {
        var name = $('#p-name').value.trim(), price = parseFloat($('#p-price').value);
        if (!name) return showErr('اكتب اسم المنتج');
        if (!(price > 0)) return showErr('اكتب سعر صح');
        var ir = await sb.from('products').insert({ shop_id: myShop.id, name: name, price: price });
        if (ir.error) return showErr(ir.error.message);
        render();
      };
      products.forEach(function (p) {
        var t = document.querySelector('[data-toggle="' + p.id + '"]');
        if (t) t.onclick = async function () {
          await sb.from('products').update({ is_available: !p.is_available }).eq('id', p.id);
          render();
        };
        var d = document.querySelector('[data-del="' + p.id + '"]');
        if (d) d.onclick = async function () {
          if (!confirm('تحذف "' + p.name + '"؟')) return;
          await sb.from('products').delete().eq('id', p.id);
          render();
        };
      });
    }

    if (tab === 'settings') {
      tb.innerHTML = '<div class="card"><h3>إعدادات المحل</h3>' +
        '<label>اسم المحل</label><input id="s-name" value="' + esc(myShop.name) + '">' +
        '<label>العنوان</label><input id="s-address" value="' + esc(myShop.address) + '">' +
        '<label>سعر التوصيل (جنيه)</label><input id="s-fee" inputmode="decimal" value="' + myShop.delivery_fee + '">' +
        '<label>حالة المحل</label><select id="s-open"><option value="open"' + (myShop.is_open ? ' selected' : '') + '>مفتوح - يستقبل طلبات</option><option value="closed"' + (!myShop.is_open ? ' selected' : '') + '>مقفول مؤقتًا</option></select>' +
        '<button class="btn" id="s-save">حفظ</button></div>' +
        '<div class="card"><h3>محفظتك</h3><div id="s-dues" class="loading">جاري الحساب…</div></div>';
      $('#s-save').onclick = async function () {
        var ur = await sb.from('shops').update({
          name: $('#s-name').value.trim() || myShop.name,
          address: $('#s-address').value.trim(),
          delivery_fee: parseFloat($('#s-fee').value) || 0,
          is_open: $('#s-open').value === 'open'
        }).eq('id', myShop.id);
        if (ur.error) return showErr(ur.error.message);
        await loadProfile();
        alert('اتحفظ ✅');
        render();
      };
      var bal2 = await myBalance();
      $('#s-dues').innerHTML = '<div class="total-line grand"><span>رصيدك (نصيبك بعد خصم عمولة 10%)</span><span>' + money(bal2 || 0) + '</span></div>' +
        '<div class="muted">أرباحك من الطلبات بتتسجل فى محفظتك عند التسليم. طلبات السحب متوقفة مؤقتاً لحد ما نراجع الترخيص.</div>' +
        '<button class="btn small" id="s-wallet" style="margin-top:8px">فتح محفظتي 💰</button>';
      $('#s-wallet').onclick = function () { go('#/wallet'); };
    }
  }

  // ---------- كابتن ----------
  async function vCaptain() {
    setMain('<div class="loading">جاري تحميل الطلبات…</div>');
    var ar = await sb.from('orders').select('*, shops(name,address,phone)').is('captain_id', null).eq('status', 'confirmed').order('created_at', { ascending: true });
    var mr = await sb.from('orders').select('*, shops(name,address,phone)').eq('captain_id', profile.id).in('status', ['confirmed', 'picked_up']).order('created_at', { ascending: false });
    if (ar.error) return showErr(ar.error.message);
    var avail = ar.data || [], mine = mr.data || [];
    var h = '';
    if (mine.length) {
      h += '<h3 style="margin-bottom:8px">طلبات معايا</h3>' + mine.map(function (o) {
        var btn = o.status === 'confirmed'
          ? '<button class="btn small" data-pick="' + o.id + '">استلمت من المحل 🛵</button>'
          : '<button class="btn small" data-done="' + o.id + '">سلّمت ✅</button>';
        return '<div class="card">' +
          '<div class="row"><div class="grow"><span class="badge ' + o.status + '">' + (STATUS[o.status] || o.status) + '</span> <b>' + money(o.total) + '</b> <span class="muted">(نصيبك ' + money(o.delivery_fee * 0.9) + ')</span></div></div>' +
          '<div class="muted" style="margin:6px 0">من: ' + esc(o.shops ? o.shops.name : '') + ' - ' + esc(o.shops ? o.shops.address : '') + '</div>' +
          '<div class="muted">إلى: ' + esc(o.delivery_address) + '</div>' +
          '<div class="muted">💵 هتحصّل من الزبون كاش: <b>' + money(o.total) + '</b></div>' +
          (o.notes ? '<div class="muted">📝 ' + esc(o.notes) + '</div>' : '') +
          '<div class="row" style="margin-top:8px">' + btn +
          '<a class="wa" target="_blank" href="' + waLink(o.customer_phone, 'أنا كابتن يلا نوبارية، جاي بالطلب') + '">واتساب الزبون</a></div></div>';
      }).join('');
    }
    h += '<h3 style="margin:14px 0 8px">طلبات متاحة للتوصيل</h3>';
    if (!avail.length) h += '<div class="notice warn">مفيش طلبات متاحة دلوقتي، جرّب بعد شوية</div>';
    h += avail.map(function (o) {
      return '<div class="card">' +
        '<div class="row"><div class="grow"><b>' + esc(o.shops ? o.shops.name : '') + '</b><div class="muted">' + esc(o.shops ? o.shops.address : '') + '</div></div>' +
        '<b>' + money(o.delivery_fee) + '</b></div>' +
        '<div class="muted" style="margin:6px 0">يوصل إلى: ' + esc(o.delivery_address) + '</div>' +
        '<div class="row"><div class="grow muted">الزبون هيدفع كاش عند الاستلام 💵 ونصيبك هيتسجل فى محفظتك عند التسليم</div>' +
        '<button class="btn small" data-take="' + o.id + '">أستلم الطلب</button></div></div>';
    }).join('');
    setMain(h);
    mine.forEach(function (o) {
      var p = document.querySelector('[data-pick="' + o.id + '"]');
      if (p) p.onclick = async function () {
        var ur = await sb.from('orders').update({ status: 'picked_up' }).eq('id', o.id);
        if (ur.error) return showErr(ur.error.message);
        render();
      };
      var d = document.querySelector('[data-done="' + o.id + '"]');
      if (d) d.onclick = async function () {
        if (!confirm('تأكيد التسليم؟ اتأكد إنك استلمت الكاش من الزبون. نصيبك هيتسجل فى محفظتك.')) return;
        var ur = await sb.from('orders').update({ status: 'delivered' }).eq('id', o.id);
        if (ur.error) return showErr(ur.error.message);
        render();
      };
    });
    avail.forEach(function (o) {
      var t = document.querySelector('[data-take="' + o.id + '"]');
      if (t) t.onclick = async function () {
        var ur = await sb.from('orders').update({ captain_id: profile.id }).eq('id', o.id);
        if (ur.error) return showErr('محدش قدر ياخد الطلب ده، ممكن حد خده قبلك');
        render();
      };
    });
    startPoll(function () { if ((location.hash || '') === '#/captain') vCaptain(); });
  }

  // ---------- أدمن ----------
  async function vAdmin(tab) {
    var tabs = '<div class="tabs">' +
      '<button data-tab="approvals" class="' + (tab === 'approvals' ? 'active' : '') + '>الموافقات</button>' +
      '<button data-tab="orders" class="' + (tab === 'orders' ? 'active' : '') + '>الطلبات</button>' +
      '<button data-tab="wallets" class="' + (tab === 'wallets' ? 'active' : '') + '>المحافظ 💰</button></div>';
    setMain(tabs + '<div id="tab-body"><div class="loading">جاري التحميل…</div></div>');
    document.querySelectorAll('.tabs button').forEach(function (b) {
      b.onclick = function () { go('#/admin' + (b.getAttribute('data-tab') === 'approvals' ? '' : '/' + b.getAttribute('data-tab'))); };
    });
    var tb = $('#tab-body');

    if (tab === 'approvals') {
      var r = await sb.from('profiles').select('*').eq('status', 'pending').order('created_at');
      if (r.error) { tb.innerHTML = '<div class="notice err">' + esc(r.error.message) + '</div>'; return; }
      var pend = r.data || [];
      if (!pend.length) { tb.innerHTML = '<div class="notice ok">مفيش حسابات مستنية موافقة ✅</div>'; return; }
      tb.innerHTML = pend.map(function (p) {
        return '<div class="card"><div class="row"><div class="grow">' +
          '<b>' + esc(p.full_name) + '</b> <span class="badge">' + (p.role === 'shop' ? '🏪 محل' : '🛵 كابتن') + '</span>' +
          '<div class="muted">' + esc(p.phone) + (p.vehicle ? ' • ' + esc(p.vehicle) : '') + '</div></div></div>' +
          '<div class="row" style="margin-top:8px"><div class="grow">' +
          '<button class="btn small" data-ok="' + p.id + '">موافقة ✅</button> ' +
          '<button class="btn small danger" data-no="' + p.id + '">رفض</button></div>' +
          '<a class="wa" target="_blank" href="' + waLink(p.phone) + '">واتساب</a></div></div>';
      }).join('');
      pend.forEach(function (p) {
        var ok = document.querySelector('[data-ok="' + p.id + '"]');
        if (ok) ok.onclick = async function () {
          var ur = await sb.from('profiles').update({ status: 'approved' }).eq('id', p.id);
          if (ur.error) return showErr(ur.error.message);
          render();
        };
        var no = document.querySelector('[data-no="' + p.id + '"]');
        if (no) no.onclick = async function () {
          var ur = await sb.from('profiles').update({ status: 'rejected' }).eq('id', p.id);
          if (ur.error) return showErr(ur.error.message);
          render();
        };
      });
      startPoll(function () { if ((location.hash || '') === '#/admin') vAdmin('approvals'); });
    }

    if (tab === 'orders') {
      var or = await sb.from('orders').select('*, shops(name)').order('created_at', { ascending: false }).limit(60);
      if (or.error) { tb.innerHTML = '<div class="notice err">' + esc(or.error.message) + '</div>'; return; }
      var orders = or.data || [];
      if (!orders.length) { tb.innerHTML = '<div class="notice warn">مفيش طلبات لسه</div>'; return; }
      tb.innerHTML = orders.map(function (o) {
        return '<div class="card"><div class="row"><div class="grow">' +
          '<b>' + esc(o.shops ? o.shops.name : '') + '</b> <span class="badge ' + o.status + '">' + (STATUS[o.status] || o.status) + '</span>' +
          '<div class="muted">' + money(o.total) + ' • عمولة التطبيق ' + money(Number(o.subtotal) * (CFG.COMMISSION_RATE || 0.1) + Number(o.delivery_fee) * (CFG.COMMISSION_RATE || 0.1)) + '</div>' +
          '<div class="muted">' + new Date(o.created_at).toLocaleString('ar-EG') + '</div></div></div></div>';
      }).join('');
    }

    if (tab === 'wallets') {
      var wr = await sb.from('wallet_requests').select('*, profiles(full_name, phone, role)').order('created_at', { ascending: false }).limit(100);
      if (wr.error) { tb.innerHTML = '<div class="notice err">' + esc(wr.error.message) + '</div>'; return; }
      var reqs = wr.data || [];
      var pendR = reqs.filter(function (q) { return q.status === 'pending'; });
      var doneR = reqs.filter(function (q) { return q.status !== 'pending'; }).slice(0, 15);
      var h = '<div class="notice warn">⚠️ المحافظ دلوقتي سجل تجريبي: الشحن والسحب متوقفين مؤقتاً، وأي قيد يدوي هنا بيتسجل باسم «قيد يدوي تجريبي» ومالوش علاقة بفلوس حقيقية.</div>';
      h += pendR.length ? pendR.map(function (q) {
        var p = q.profiles || {};
        return '<div class="card"><div class="row"><div class="grow">' +
          '<b>' + esc(p.full_name || '؟') + '</b> <span class="badge">' + (p.role === 'shop' ? '🏪' : p.role === 'captain' ? '🛵' : '🧺') + '</span>' +
          '<div class="total-line"><span>' + (q.kind === 'topup' ? 'طلب شحن' : 'طلب سحب') + '</span><b>' + money(q.amount) + '</b></div>' +
          (q.note ? '<div class="muted">' + esc(q.note) + '</div>' : '') +
          '<div class="muted">' + new Date(q.created_at).toLocaleString('ar-EG') + '</div></div></div>' +
          '<div class="row" style="margin-top:8px"><div class="grow">' +
          '<button class="btn small" data-wok="' + q.id + '">تأكيد ✅</button> ' +
          '<button class="btn small danger" data-wno="' + q.id + '">رفض</button></div>' +
          '<a class="wa" target="_blank" href="' + waLink(p.phone || '') + '">واتساب</a></div></div>';
      }).join('') : '<div class="notice ok">مفيش طلبات شحن أو سحب مستنية ✅</div>';
      var br = await sb.from('wallets').select('*, profiles(full_name, phone, role)').order('balance', { ascending: false }).limit(100);
      var bals = br.data || [];
      if (bals.length) {
        h += '<h3 style="margin:14px 0 8px">الأرصدة</h3>' + bals.map(function (w) {
          var p = w.profiles || {};
          return '<div class="card"><div class="row"><div class="grow"><b>' + esc(p.full_name || '؟') + '</b>' +
            ' <span class="badge">' + (p.role === 'shop' ? '🏪' : p.role === 'captain' ? '🛵' : p.role === 'admin' ? '⭐' : '🧺') + '</span>' +
            '<div class="muted">' + esc(p.phone || '') + '</div></div>' +
            '<b>' + money(w.balance) + '</b></div>' +
            '<div class="row" style="margin-top:8px">' +
            '<button class="btn small ghost" data-plus="' + w.user_id + '">＋ قيد إضافة (تجريبي)</button> ' +
            '<button class="btn small ghost danger" data-minus="' + w.user_id + '">－ قيد خصم (تجريبي)</button></div></div>';
        }).join('');
      }
      if (doneR.length) {
        h += '<h3 style="margin:14px 0 8px">آخر الطلبات المنفذة</h3>' + doneR.map(function (q) {
          var p = q.profiles || {};
          return '<div class="card"><div class="row"><div class="grow">' +
            '<b>' + esc(p.full_name || '؟') + '</b> <span class="badge ' + (q.status === 'approved' ? 'delivered' : 'cancelled') + '">' + (q.status === 'approved' ? 'اتنفذ ✅' : 'اترفض ❌') + '</span>' +
            '<div class="muted">' + (q.kind === 'topup' ? 'شحن' : 'سحب') + ' ' + money(q.amount) + (q.admin_note ? ' • ' + esc(q.admin_note) : '') + '</div></div></div></div>';
        }).join('');
      }
      tb.innerHTML = h;
      async function adminAdjust(w, sign) {
        var p = w.profiles || {};
        var amt = parseFloat(prompt('قيد تجريبي - ' + (sign > 0 ? 'إضافة' : 'خصم') + ' كام جنيه ' + (sign > 0 ? 'لـ' : 'من') + ' ' + (p.full_name || '') + '؟'));
        if (!(amt > 0)) return;
        var note = prompt('سبب القيد (هيظهر فى دفتر المستخدم):') || '';
        var r = await sb.rpc('admin_adjust_wallet', { p_user: w.user_id, p_amount: sign * amt, p_note: note });
        if (r.error) {
          if (r.error.message && r.error.message.indexOf('balance') >= 0) return showErr('الرصيد مش كفاية للخصم ده');
          return showErr(r.error.message);
        }
        render();
      }
      bals.forEach(function (w) {
        var plus = document.querySelector('[data-plus="' + w.user_id + '"]');
        if (plus) plus.onclick = function () { adminAdjust(w, 1); };
        var minus = document.querySelector('[data-minus="' + w.user_id + '"]');
        if (minus) minus.onclick = function () { adminAdjust(w, -1); };
      });
      pendR.forEach(function (q) {
        var ok = document.querySelector('[data-wok="' + q.id + '"]');
        if (ok) ok.onclick = async function () {
          var msg = q.kind === 'topup'
            ? 'تأكيد الشحن؟ الشحن متوقف مؤقتاً، فالتأكيد ده قيد تجريبي على السجل بس'
            : 'تأكيد السحب؟ السحب متوقف مؤقتاً، فالتأكيد ده قيد تجريبي على السجل بس';
          if (!confirm(msg)) return;
          var ur = await sb.from('wallet_requests').update({ status: 'approved' }).eq('id', q.id);
          if (ur.error) {
            if (ur.error.message && ur.error.message.indexOf('balance') >= 0) return showErr('رصيد المستخدم مش كفاية للسحب ده');
            return showErr(ur.error.message);
          }
          render();
        };
        var no = document.querySelector('[data-wno="' + q.id + '"]');
        if (no) no.onclick = async function () {
          var note = prompt('سبب الرفض (اختياري):') || '';
          var ur = await sb.from('wallet_requests').update({ status: 'rejected', admin_note: note }).eq('id', q.id);
          if (ur.error) return showErr(ur.error.message);
          render();
        };
      });
      startPoll(function () { if ((location.hash || '') === '#/admin/wallets') vAdmin('wallets'); });
    }
  }

  // ---------- تشغيل ----------
  window.addEventListener('hashchange', render);
  $('#brand').onclick = function () { go(''); render(); };

  (async function init() {
    $('#brand').textContent = APP_NAME + ' 🛵';
    loadCart();
    if (sb) {
      sb.auth.onAuthStateChange(function (event, s) {
        if (event === 'SIGNED_OUT') { session = null; profile = null; render(); }
      });
      await loadSession();
    }
    render();
  })();
})();
