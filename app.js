/* Receipt Maker — one row model, three renderers (HTML preview, PNG canvas, plain text). All local. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$, h = S3.h;
  var LBL = {
    receipt: ["Receipt", "إيصال"], no: ["No.", "رقم"], date: ["Date", "التاريخ"], customer: ["Customer", "العميل"],
    subtotal: ["Subtotal", "المجموع"], discount: ["Discount", "الخصم"], tax: ["Tax", "الضريبة"], total: ["Total", "الإجمالي"],
    payment: ["Payment", "الدفع"], paid: ["Paid", "المدفوع"], change: ["Change", "الباقي"], taxId: ["Tax no.", "الرقم الضريبي"], phone: ["Tel", "هاتف"],
    cash: ["Cash", "نقداً"], card: ["Card", "بطاقة"], transfer: ["Bank transfer", "تحويل بنكي"], wallet: ["E-wallet", "محفظة إلكترونية"], other: ["Other", "أخرى"]
  };
  var PAYS = ["cash", "card", "transfer", "wallet", "other"];
  var MONO = 'ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace', SANS = 'Inter, system-ui, "Segoe UI", Tahoma, sans-serif';
  var shop, rc;

  // ---------- pure logic ----------
  function num(v) { var n = typeof v === "number" ? v : parseFloat(v); return isFinite(n) ? n : 0; }
  function round(n, d) {
    if (!isFinite(n)) return 0;
    var s = n < 0 ? -1 : 1, a = +Math.abs(n).toPrecision(12), str = String(a); // toPrecision drops float noise: 1.72549999… → 1.7255
    if (/e/i.test(str)) return s * Math.round(a * Math.pow(10, d)) / Math.pow(10, d);
    return s * Number(Math.round(Number(str + "e" + d)) + "e-" + d);
  }
  function calc(r, d) {
    var sub = 0;
    var lines = r.items.map(function (it) { var a = round(num(it.qty) * num(it.price), d); sub += a; return a; });
    sub = round(sub, d);
    var disc = r.discType === "amt" ? Math.min(sub, Math.max(0, round(num(r.disc), d))) : round(sub * Math.min(100, Math.max(0, num(r.disc))) / 100, d);
    var net = round(sub - disc, d), tax = round(net * Math.min(100, Math.max(0, num(r.tax))) / 100, d), total = round(net + tax, d);
    var paid = Math.max(0, num(r.paid));
    return { lines: lines, sub: sub, disc: disc, tax: tax, total: total, paid: paid, change: paid ? round(paid - total, d) : 0 };
  }
  // Bidi helpers: numbers inside Arabic labels must not get reordered ("هاتف: 06 555 0123").
  function iso(t) { return "\u2066" + t + "\u2069"; }
  function dirOf(t) { return /^[^A-Za-z\u0590-\u08FF]*[\u0590-\u08FF]/.test(t) ? "rtl" : "ltr"; }
  function label(k, lang) { var p = LBL[k]; return lang === "ar" ? p[1] : lang === "both" ? p[0] + " / " + p[1] : p[0]; }
  // Greedy word wrap; words longer than a line are split by character.
  function wrap(ctx, text, max) {
    var out = [], line = "";
    String(text).split(/\s+/).filter(Boolean).forEach(function (w) {
      while (ctx.measureText(w).width > max && w.length > 1) {
        var k = w.length; while (k > 1 && ctx.measureText(w.slice(0, k)).width > max) k--;
        if (line) { out.push(line); line = ""; }
        out.push(w.slice(0, k)); w = w.slice(k);
      }
      var t = line ? line + " " + w : w;
      if (ctx.measureText(t).width > max && line) { out.push(line); line = w; } else line = t;
    });
    if (line) out.push(line);
    return out.length ? out : [""];
  }

  // ---------- state (stored JSON is coerced back into shape) ----------
  function str(v, max) { return typeof v === "string" ? v.slice(0, max || 160) : ""; }
  function cleanShop(o) {
    o = o && typeof o === "object" ? o : {};
    return {
      name: str(o.name, 80), address: str(o.address), phone: str(o.phone, 40), taxId: str(o.taxId, 40),
      currency: typeof o.currency === "string" ? o.currency.slice(0, 8) : "JD", decimals: [0, 2, 3].indexOf(+o.decimals) >= 0 ? +o.decimals : 2,
      prefix: typeof o.prefix === "string" ? o.prefix.slice(0, 10) : "R-", footer: typeof o.footer === "string" ? o.footer.slice(0, 120) : "Thank you! شكراً لزيارتكم",
      fmt: o.fmt === "a5" ? "a5" : "thermal", lang: ["en", "ar", "both"].indexOf(o.lang) >= 0 ? o.lang : "en"
    };
  }
  function nowLocal() { var d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
  function cleanRc(o) {
    o = o && typeof o === "object" ? o : {};
    return {
      no: Math.max(1, Math.floor(num(o.no)) || 1), when: typeof o.when === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(o.when) ? o.when : nowLocal(),
      customer: str(o.customer, 80), pay: PAYS.indexOf(o.pay) >= 0 ? o.pay : "cash",
      items: (Array.isArray(o.items) ? o.items : []).slice(0, 200).map(function (it) { it = it || {}; return { name: str(it.name, 120), qty: num(it.qty), price: num(it.price) }; }),
      disc: num(o.disc), discType: o.discType === "amt" ? "amt" : "pct", tax: num(o.tax), paid: num(o.paid), note: str(o.note, 200)
    };
  }
  var saveSoon = S3.debounce(function () {
    if (S3.store("receipt.shop", shop) === undefined || S3.store("receipt.current", rc) === undefined) S3.toast("Couldn't save — browser storage is blocked or full", "error");
  }, 300);

  // ---------- model ----------
  function money(v) {
    var s = new Intl.NumberFormat("en-US", { minimumFractionDigits: shop.decimals, maximumFractionDigits: shop.decimals }).format(v);
    return shop.currency ? s + " " + shop.currency : s;
  }
  function fmtNum(v) { return String(Math.round(v * 1000) / 1000); }
  function fmtWhen(s) { var p = s.split(/[-T:]/); return p[2] + "/" + p[1] + "/" + p[0] + "  " + p[3] + ":" + p[4]; }
  function model() {
    var c = calc(rc, shop.decimals), L = function (k) { return label(k, shop.lang); }, rows = [];
    rows.push({ t: "title", text: shop.name || "Your shop", ph: !shop.name });
    if (shop.address) rows.push({ t: "center", text: shop.address });
    if (shop.phone) rows.push({ t: "center", text: L("phone") + ": " + iso(shop.phone) });
    if (shop.taxId) rows.push({ t: "center", text: L("taxId") + ": " + iso(shop.taxId) });
    rows.push({ t: "rule" });
    rows.push({ t: "head", text: L("receipt") });
    rows.push({ t: "kv", k: L("no"), v: shop.prefix + rc.no });
    rows.push({ t: "kv", k: L("date"), v: fmtWhen(rc.when) });
    if (rc.customer) rows.push({ t: "kv", k: L("customer"), v: rc.customer });
    rows.push({ t: "rule" });
    var any = false;
    rc.items.forEach(function (it, i) {
      if (!it.name && !num(it.price)) return;
      any = true;
      rows.push({ t: "item", name: it.name || "—", sub: fmtNum(num(it.qty)) + " × " + money(num(it.price)), amt: money(c.lines[i]) });
    });
    if (!any) rows.push({ t: "center", text: "Add items in the form", ph: true });
    rows.push({ t: "rule" });
    rows.push({ t: "kv", k: L("subtotal"), v: money(c.sub) });
    if (c.disc) rows.push({ t: "kv", k: L("discount") + (rc.discType === "pct" ? " " + iso(fmtNum(num(rc.disc)) + "%") : ""), v: "−" + money(c.disc) });
    if (c.tax) rows.push({ t: "kv", k: L("tax") + " " + iso(fmtNum(num(rc.tax)) + "%"), v: money(c.tax) });
    rows.push({ t: "total", k: L("total"), v: money(c.total) });
    rows.push({ t: "kv", k: L("payment"), v: L(rc.pay) });
    if (c.paid) { rows.push({ t: "kv", k: L("paid"), v: money(c.paid) }); rows.push({ t: "kv", k: L("change"), v: money(c.change) }); }
    if (rc.note || shop.footer) rows.push({ t: "rule" });
    if (rc.note) rows.push({ t: "center", text: rc.note });
    if (shop.footer) rows.push({ t: "center", text: shop.footer, bold: true });
    return rows;
  }

  // ---------- renderers ----------
  function renderHTML() {
    var el = $("#receipt");
    el.className = "receipt " + shop.fmt;
    el.dir = shop.lang === "ar" ? "rtl" : "ltr";
    el.textContent = "";
    model().forEach(function (r) {
      var row;
      if (r.t === "rule") row = h("hr");
      else if (r.t === "item") row = h("div", { "class": "r-item" }, [h("div", { "class": "r-name", dir: "auto", text: r.name }), h("div", { "class": "r-kv" }, [h("span", { "class": "r-sub", dir: "ltr", text: r.sub }), h("b", { dir: "ltr", text: r.amt })])]);
      else if (r.t === "kv" || r.t === "total") row = h("div", { "class": "r-kv" + (r.t === "total" ? " r-total" : "") }, [h("span", { dir: dirOf(r.k), text: r.k }), h("b", { dir: dirOf(r.v), text: r.v })]);
      else row = h("div", { "class": "r-" + r.t + (r.ph ? " ph" : "") + (r.bold ? " r-bold" : ""), dir: "auto", text: r.text });
      el.appendChild(row);
    });
  }
  function renderText() {
    var W = 32, out = [];
    function pad(a, b) { var n = Math.max(1, W - a.length - b.length); return a + " ".repeat(n) + b; }
    function center(t) { return " ".repeat(Math.max(0, Math.floor((W - t.length) / 2))) + t; }
    model().forEach(function (r) {
      if (r.ph) return;
      if (r.t === "rule") out.push("-".repeat(W));
      else if (r.t === "item") { out.push(r.name); out.push(pad("  " + r.sub, r.amt)); }
      else if (r.t === "kv") out.push(pad(r.k, r.v));
      else if (r.t === "total") out.push(pad(r.k.toUpperCase(), r.v));
      else out.push(center(r.text));
    });
    return out.join("\n").replace(/[\u2066-\u2069]/g, "");
  }
  function renderCanvas() {
    var thermal = shop.fmt === "thermal", W = thermal ? 576 : 1240, P = thermal ? 26 : 96, fs = thermal ? 22 : 28;
    var family = thermal ? MONO : SANS, rtl = shop.lang === "ar", rows = model();
    var cv = document.createElement("canvas"), c = cv.getContext("2d");
    var S = rtl ? W - P : P, E = rtl ? P : W - P, aS = rtl ? "right" : "left", aE = rtl ? "left" : "right";
    function f(size, bold) { c.font = (bold ? "700 " : "400 ") + size + "px " + family; }
    function text(t, x, y, align) { c.direction = dirOf(t); c.textAlign = align; c.fillText(t, x, y); }
    function pass(draw) {
      var y = P;
      if (draw) { c.fillStyle = "#fff"; c.fillRect(0, 0, cv.width, cv.height); c.fillStyle = "#111"; c.strokeStyle = "#999"; c.textBaseline = "top"; }
      rows.forEach(function (r) {
        if (r.ph) return;
        if (r.t === "rule") {
          if (draw) { c.setLineDash([6, 6]); c.lineWidth = 2; c.beginPath(); c.moveTo(P, y + fs * 0.5); c.lineTo(W - P, y + fs * 0.5); c.stroke(); c.setLineDash([]); }
          y += fs; return;
        }
        if (r.t === "title" || r.t === "center" || r.t === "head") {
          var size = r.t === "title" ? fs * 1.45 : r.t === "head" ? fs * 1.1 : fs * 0.92;
          f(size, r.t !== "center" || r.bold);
          wrap(c, r.text, W - P * 2).forEach(function (l) { if (draw) text(l, W / 2, y, "center"); y += size * 1.35; });
          return;
        }
        if (r.t === "item") {
          f(fs, true);
          wrap(c, r.name, W - P * 2).forEach(function (l) { if (draw) text(l, S, y, aS); y += fs * 1.3; });
          if (draw) { f(fs * 0.9, false); c.fillStyle = "#555"; text(r.sub, S, y, aS); c.fillStyle = "#111"; f(fs, true); text(r.amt, E, y, aE); }
          y += fs * 1.55; return;
        }
        var big = r.t === "total", sz = big ? fs * 1.3 : fs;
        if (draw) { f(sz, big); text(r.k, S, y, aS); f(sz, true); text(r.v, E, y, aE); }
        y += sz * (big ? 1.6 : 1.4);
      });
      return y + P;
    }
    cv.width = W; cv.height = 10;
    var hgt = Math.ceil(pass(false));
    cv.height = thermal ? hgt : Math.max(hgt, Math.round(W * 210 / 148));
    pass(true);
    return cv;
  }

  // ---------- editor ----------
  var editor = $("#editor");
  function drawItems() {
    var box = $("#items"); box.textContent = "";
    if (!rc.items.length) box.appendChild(h("div", { "class": "empty" }, [h("b", { text: "No items" }), "Add what you sold."]));
    rc.items.forEach(function (it, i) {
      box.appendChild(h("div", { "class": "item", "data-i": i }, [
        h("label", { "class": "field it-name" }, ["Item", h("input", { "class": "input", "data-f": "name", dir: "auto", maxlength: "120", value: it.name, placeholder: "Product" })]),
        h("label", { "class": "field" }, ["Qty", h("input", { "class": "input", type: "number", step: "any", inputmode: "decimal", "data-f": "qty", value: fmtNum(it.qty) })]),
        h("label", { "class": "field" }, ["Price", h("input", { "class": "input", type: "number", step: "any", inputmode: "decimal", "data-f": "price", value: fmtNum(it.price) })]),
        h("button", { "class": "btn ghost icon small it-del", "aria-label": "Remove item " + (i + 1), title: "Remove", html: S3.icon("trash") })
      ]));
    });
  }
  function fill() {
    $$("[data-r]", editor).forEach(function (el) { var v = rc[el.dataset.r]; el.value = typeof v === "number" ? (v || el.dataset.r === "no" ? fmtNum(v) : "") : v; });
    $$("[data-s]", editor).forEach(function (el) { el.value = shop[el.dataset.s]; });
    $$("#fmt button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === shop.fmt)); });
    $$("#lang button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === shop.lang)); });
    drawItems();
  }
  function update() { renderHTML(); saveSoon(); }
  editor.addEventListener("input", function (e) {
    var d = e.target.dataset, v = e.target.value;
    if (d.r) rc[d.r] = ["no", "disc", "tax", "paid"].indexOf(d.r) >= 0 ? num(v) : v;
    else if (d.s) shop[d.s] = d.s === "decimals" ? +v : v;
    else if (d.f) { var i = +e.target.closest(".item").dataset.i; rc.items[i][d.f] = d.f === "name" ? v : num(v); }
    else return;
    if (d.r === "no") rc.no = Math.max(1, Math.floor(rc.no) || 1);
    update();
  });
  $("#items").addEventListener("click", function (e) {
    var b = e.target.closest(".it-del"); if (!b) return;
    rc.items.splice(+b.closest(".item").dataset.i, 1); drawItems(); update();
  });
  $("#addItem").addEventListener("click", function () {
    rc.items.push({ name: "", qty: 1, price: 0 }); drawItems(); update();
    var last = $$("#items .item:last-child input")[0]; if (last) last.focus();
  });
  $("#new").addEventListener("click", function () {
    var old = rc;
    rc = cleanRc({ no: old.no + 1, pay: old.pay, tax: old.tax, items: [{ qty: 1 }] });
    fill(); update(); S3.toast("New receipt " + shop.prefix + rc.no);
  });
  function seg(id, key) {
    $$("#" + id + " button").forEach(function (b) {
      b.addEventListener("click", function () { shop[key] = b.dataset.v; fill(); update(); });
    });
  }
  seg("fmt", "fmt"); seg("lang", "lang");

  // ---------- output ----------
  var pageStyle = document.head.appendChild(document.createElement("style"));
  function setPage() {
    var el = $("#receipt");
    pageStyle.textContent = shop.fmt === "thermal"
      ? "@page { size: 80mm " + Math.ceil(el.offsetHeight * 25.4 / 96 + 4) + "mm; margin: 0; }"
      : "@page { size: A5; margin: 0; }";
  }
  window.addEventListener("beforeprint", setPage);
  $("#print").addEventListener("click", function () { setPage(); window.print(); S3.done(); });
  $("#png").addEventListener("click", function () {
    (document.fonts ? document.fonts.ready : Promise.resolve()).then(function () {
      renderCanvas().toBlob(function (b) { S3.download(b, "receipt-" + (shop.prefix + rc.no).replace(/[^\w-]+/g, "") + ".png"); S3.done(); }, "image/png");
    });
  });
  $("#copy").addEventListener("click", function () { S3.copy(renderText(), "Receipt text copied"); S3.done(); });

  // ---------- boot ----------
  shop = cleanShop(S3.store("receipt.shop"));
  rc = cleanRc(S3.store("receipt.current") || { items: [{ qty: 1 }] });
  fill(); renderHTML();

  window.S3_DEMO = function () {
    shop = cleanShop({ name: "Zaytoun Corner Café", address: "Rainbow St. 12, Amman", phone: "06 555 0123", taxId: "4400112", currency: "JD", decimals: 3, prefix: "R-", footer: "Thank you! شكراً لزيارتكم", lang: "both", fmt: "thermal" });
    rc = cleanRc({ no: 1043, pay: "cash", paid: 10, disc: 10, discType: "pct", tax: 16, customer: "Table 4",
      items: [{ name: "Cappuccino", qty: 2, price: 2.25 }, { name: "Za'atar manakeesh", qty: 1, price: 1.5 }, { name: "Fresh orange juice", qty: 1, price: 2 }] });
    fill(); update();
  };

  window.S3_SELFTEST = function () {
    var c = calc(cleanRc({ items: [{ qty: 2, price: 3.5 }, { qty: 1, price: 10.255 }], disc: 10, discType: "pct", tax: 16, paid: 20 }), 3);
    // 17.255 − 1.726 (1.7255) = 15.529 → tax 2.485 (2.48464) → 18.014; change 1.986
    var ok1 = c.sub === 17.255 && c.disc === 1.726 && c.tax === 2.485 && c.total === 18.014 && c.change === 1.986;
    var c2 = calc(cleanRc({ items: [{ qty: 1, price: 5 }], disc: 50, discType: "amt", tax: 10 }), 2);
    var c3 = calc(cleanRc({ items: [{ qty: 3, price: 0.335 }], disc: 0 }), 2); // 1.005 → 1.01
    var ok2 = c2.disc === 5 && c2.total === 0 && c2.change === 0 && c3.total === 1.01;
    var fake = { measureText: function (t) { return { width: t.length * 10 }; } };
    var w1 = wrap(fake, "aa bb cc", 50), w2 = wrap(fake, "abcdefghij", 40);
    var ok3 = w1.join("|") === "aa bb|cc" && w2.join("|") === "abcd|efgh|ij";
    var ok4 = dirOf("Thank you! شكراً") === "ltr" && dirOf("«شكراً» Thanks") === "rtl" && dirOf("8.352 JD") === "ltr" && label("total", "ar") === "الإجمالي" && label("total", "both") === "Total / الإجمالي" && label("cash", "en") === "Cash";
    var bad = cleanRc({ no: -5, pay: "<script>", items: "x", when: "yesterday" }), bs = cleanShop({ decimals: 7, lang: "fr", fmt: 1 });
    var ok5 = bad.no === 1 && bad.pay === "cash" && bad.items.length === 0 && /T/.test(bad.when) && bs.decimals === 2 && bs.lang === "en" && bs.fmt === "thermal";
    return ok1 && ok2 && ok3 && ok4 && ok5;
  };
})();
