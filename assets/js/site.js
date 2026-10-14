/*
  Rizq Rasan website behaviour. No libraries.

  Motion follows a few rules:
  - Feedback starts on pointer-down, never on release.
  - Anything the user can touch moves on a spring, so it can be grabbed or reversed
    mid-flight and always starts from where it is on screen, at the speed it is going.
  - A drag tracks the finger 1:1, resists past its edge, and hands its release
    velocity to the spring that finishes the move.
  - With "reduce motion" on, movement becomes an instant change or a short fade.
*/
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.remove('no-js');
  root.classList.add('js');

  var motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  function reducedMotion() { return motionQuery.matches; }

  function each(selector, fn, scope) {
    Array.prototype.forEach.call((scope || document).querySelectorAll(selector), fn);
  }
  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  /* ---------------------------------------------------------------------------
     Account menu, shown instead of Log in and Join when signed in. A button
     that shows and hides a short list of links; Escape, a tap outside or
     moving focus away closes it.
  --------------------------------------------------------------------------- */
  each('[data-account]', function (wrap) {
    var button = wrap.querySelector('[data-account-toggle]');
    var menu = wrap.querySelector('[data-account-menu]');
    if (!button || !menu) return;
    function outside(e) { if (!wrap.contains(e.target)) close(false); }
    function onKey(e) { if (e.key === 'Escape') close(true); }
    function open() {
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(function () { menu.classList.add('is-open'); });
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', onKey);
    }
    function close(returnFocus) {
      if (menu.hidden) return;
      menu.classList.remove('is-open');
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', onKey);
      if (returnFocus) button.focus();
    }
    button.addEventListener('click', function () { if (menu.hidden) open(); else close(false); });
    wrap.addEventListener('focusout', function (e) { if (e.relatedTarget && !wrap.contains(e.relatedTarget)) close(false); });
  });

  /* ---------------------------------------------------------------------------
     Spring, described by damping ratio and response (seconds), as on Apple platforms.
     1.0 damping settles with no overshoot; below 1.0 it bounces.
     Re-targeting keeps the current value and velocity, so motion never jumps.
  --------------------------------------------------------------------------- */
  function Spring(options) {
    this.value = options.value || 0;
    this.target = this.value;
    this.velocity = 0;
    this.damping = options.damping == null ? 1 : options.damping;
    this.response = options.response || 0.4;
    this.precision = options.precision || 0.01;
    this.onUpdate = options.onUpdate || function () {};
    this.onRest = null;
    this.frame = 0;
    this.last = 0;
    this.tick = this.tick.bind(this);
  }

  Spring.prototype.to = function (target, options) {
    options = options || {};
    this.target = target;
    if (options.damping != null) this.damping = options.damping;
    if (options.response != null) this.response = options.response;
    if (options.velocity != null) this.velocity = options.velocity;
    this.onRest = options.onRest || null;
    if (options.instant || (reducedMotion() && !this.allowReduced)) {
      this.set(target);
      this.rest();
      return;
    }
    if (!this.frame) {
      this.last = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
  };

  Spring.prototype.set = function (value) {
    this.stop();
    this.value = this.target = value;
    this.onUpdate(value);
  };

  Spring.prototype.stop = function () {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.velocity = 0;
  };

  Spring.prototype.isMoving = function () { return this.frame !== 0; };

  Spring.prototype.rest = function () {
    var done = this.onRest;
    this.onRest = null;
    if (done) done();
  };

  Spring.prototype.tick = function (now) {
    // Clamp long frames (background tabs) so the spring never explodes.
    var dt = Math.min((now - this.last) / 1000, 1 / 30);
    this.last = now;
    var omega = (2 * Math.PI) / this.response;
    var stiffness = omega * omega;
    var friction = 2 * this.damping * omega;
    var steps = Math.max(1, Math.ceil(dt * 240));
    var h = dt / steps;
    for (var i = 0; i < steps; i++) {
      var force = -stiffness * (this.value - this.target) - friction * this.velocity;
      this.velocity += force * h;
      this.value += this.velocity * h;
    }
    if (Math.abs(this.value - this.target) < this.precision && Math.abs(this.velocity) < this.precision * 20) {
      this.value = this.target;
      this.velocity = 0;
      this.frame = 0;
      this.onUpdate(this.value);
      this.rest();
      return;
    }
    this.onUpdate(this.value);
    this.frame = requestAnimationFrame(this.tick);
  };

  // Where a flick would come to rest, using the same deceleration as scrolling.
  function project(velocity, rate) {
    rate = rate || 0.998;
    return ((velocity / 1000) * rate) / (1 - rate);
  }

  // Past an edge the element follows less and less, like stretching something real.
  function rubberband(overshoot, dimension) {
    var c = 0.55;
    var sign = overshoot < 0 ? -1 : 1;
    var x = Math.abs(overshoot);
    return sign * ((x * dimension * c) / (dimension + c * x));
  }

  // Release velocity in px/s from the last ~100 ms of pointer samples.
  function VelocityTracker() { this.samples = []; }
  VelocityTracker.prototype.add = function (y) {
    var now = performance.now();
    this.samples.push({ y: y, t: now });
    while (this.samples.length > 2 && now - this.samples[0].t > 100) this.samples.shift();
  };
  VelocityTracker.prototype.velocity = function () {
    var s = this.samples;
    if (s.length < 2) return 0;
    var first = s[0], last = s[s.length - 1];
    var dt = (last.t - first.t) / 1000;
    if (dt <= 0 || performance.now() - last.t > 80) return 0;
    return (last.y - first.y) / dt;
  };

  /* ---------------------------------------------------------------------------
     Press feedback on pointer-down (iOS Safari is slow to apply :active).
  --------------------------------------------------------------------------- */
  var pressable = '.btn, .card--link, .icon-button, .lang-toggle';
  document.addEventListener('pointerdown', function (e) {
    var el = e.target.closest && e.target.closest(pressable);
    if (!el) return;
    el.classList.add('is-pressed');
    function release() {
      el.classList.remove('is-pressed');
      el.removeEventListener('pointerup', release);
      el.removeEventListener('pointercancel', release);
      el.removeEventListener('pointerleave', release);
    }
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
  }, { passive: true });

  /* ---------------------------------------------------------------------------
     Header.
     - The scroll-edge fade appears only once content is underneath it.
     - Scrolling down tucks it away; any scroll up (or focus inside it) brings it
       straight back. It never tucks while the menu or account menu is open.
  --------------------------------------------------------------------------- */
  var header = document.querySelector('[data-header]');
  if (header) {
    var ticking = false;
    var lastY = window.scrollY;
    var setTucked = function (on) { header.classList.toggle('is-tucked', on); };
    var updateHeader = function () {
      var y = Math.max(0, window.scrollY);
      var delta = y - lastY;
      header.classList.toggle('is-scrolled', y > 4);
      var busy = header.contains(document.activeElement) || header.querySelector('[aria-expanded="true"]') || root.classList.contains('has-sheet');
      if (busy || y < header.offsetHeight * 2) setTucked(false);
      else if (delta > 6) setTucked(true);
      else if (delta < -6) setTucked(false);
      if (Math.abs(delta) > 6 || y < header.offsetHeight * 2) lastY = y;
      ticking = false;
    };
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(updateHeader); }
    }, { passive: true });
    header.addEventListener('focusin', function () { setTucked(false); });
    updateHeader();
  }

  /* ---------------------------------------------------------------------------
     Header links: one highlight slides (on springs, so it can be caught and
     redirected mid-move) to the link under the pointer or keyboard focus, and
     settles back on the current page when the pointer leaves.
  --------------------------------------------------------------------------- */
  each('[data-nav]', function (list) {
    var pill = list.querySelector('[data-nav-indicator]');
    if (!pill) return;
    var links = list.querySelectorAll('.site-nav__link');
    var current = list.querySelector('.site-nav__link[aria-current="page"]');
    var x = new Spring({ response: 0.32, onUpdate: function () { draw(); } });
    var w = new Spring({ response: 0.32, onUpdate: function () { draw(); } });
    var shown = false;
    function draw() { pill.style.transform = 'translateX(' + x.value.toFixed(2) + 'px)'; pill.style.width = w.value.toFixed(2) + 'px'; }
    function moveTo(link, instant) {
      if (!link) { pill.style.opacity = '0'; shown = false; return; }
      var box = link.getBoundingClientRect();
      var left = box.left - list.getBoundingClientRect().left;
      var width = box.width;
      if (!shown || instant) { x.set(left); w.set(width); }
      else { x.to(left); w.to(width); }
      pill.style.opacity = '1';
      shown = true;
    }
    list.classList.add('has-indicator');
    moveTo(current, true);
    Array.prototype.forEach.call(links, function (link) {
      link.addEventListener('pointerenter', function () { moveTo(link); });
      link.addEventListener('focus', function () { moveTo(link); });
    });
    list.addEventListener('pointerleave', function () { moveTo(current); });
    list.addEventListener('focusout', function (e) { if (!list.contains(e.relatedTarget)) moveTo(current); });
    // Fonts arriving or a resize move the links: snap the highlight to its link.
    var resnap = function () { moveTo(current, true); };
    window.addEventListener('resize', resnap);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(resnap);
  });

  /* ---------------------------------------------------------------------------
     Menu sheet. Drops from the top, anchored to the menu button, and leaves the
     same way. Drag it up to dismiss; a quick flick is enough.
  --------------------------------------------------------------------------- */
  (function () {
    var sheet = document.querySelector('[data-menu-sheet]');
    var openButton = document.querySelector('[data-menu-open]');
    if (!sheet || !openButton) return;
    var panel = sheet.querySelector('[data-menu-panel]');
    var scrim = sheet.querySelector('.menu-sheet__scrim');
    var background = document.querySelectorAll('.skip-link, [data-header], main, .site-footer');
    var isOpen = false;
    var height = 1;

    function render(y) {
      var progress = clamp(1 + y / height, 0, 1);
      scrim.style.opacity = progress;
      if (reducedMotion() && !drag.active) {
        panel.style.transform = 'none';
        panel.style.opacity = progress;
      } else {
        panel.style.transform = 'translate3d(0,' + y + 'px,0)';
        panel.style.opacity = '';
      }
    }

    var spring = new Spring({ damping: 1, response: 0.4, precision: 0.5, onUpdate: render });

    // With reduced motion the sheet fades in place instead of sliding.
    var fade = new Spring({ damping: 1, response: 0.2, precision: 0.005, onUpdate: function (p) {
      spring.value = -height * (1 - p);
      render(spring.value);
    } });
    fade.allowReduced = true;
    function animate(target, options) {
      if (!reducedMotion()) { spring.to(target, options); return; }
      fade.set(clamp(1 + spring.value / height, 0, 1));
      fade.to(target === 0 ? 1 : 0, { onRest: options.onRest });
    }

    function setBackgroundInert(on) {
      Array.prototype.forEach.call(background, function (el) {
        if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert');
      });
    }

    function measure() {
      height = Math.max(1, panel.offsetHeight);
      // When everything fits, the whole panel can be dragged. When it scrolls,
      // only the grabber can, so scrolling keeps working.
      panel.style.touchAction = panel.scrollHeight <= panel.clientHeight + 1 ? 'none' : '';
    }

    function open() {
      if (isOpen) return;
      isOpen = true;
      var wasHidden = sheet.hidden;
      sheet.hidden = false;
      measure();
      if (wasHidden) spring.set(-height);
      openButton.setAttribute('aria-expanded', 'true');
      root.classList.add('has-sheet');
      setBackgroundInert(true);
      animate(0, { damping: 1, response: 0.4 });
      panel.focus({ preventScroll: true });
    }

    function close(velocity, flicked) {
      if (!isOpen) return;
      isOpen = false;
      openButton.setAttribute('aria-expanded', 'false');
      root.classList.remove('has-sheet');
      setBackgroundInert(false);
      animate(-height, {
        damping: 1,
        response: flicked ? 0.3 : 0.35,
        velocity: velocity || 0,
        onRest: function () {
          sheet.hidden = true;
          panel.style.transform = '';
          panel.style.opacity = '';
          scrim.style.opacity = '';
        }
      });
      openButton.focus({ preventScroll: true });
    }

    openButton.addEventListener('click', open);
    each('[data-menu-close]', function (el) { el.addEventListener('click', function () { close(); }); }, sheet);

    // Following a link inside the menu closes it (matters for same-page anchors).
    panel.addEventListener('click', function (e) {
      if (drag.suppressClick) { e.preventDefault(); e.stopPropagation(); drag.suppressClick = false; return; }
      if (e.target.closest('a[href]')) close();
    }, true);

    document.addEventListener('keydown', function (e) {
      if (!isOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;
      var focusables = panel.querySelectorAll('a[href], button:not([disabled])');
      if (!focusables.length) return;
      var first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    // The menu is for small screens only; close it if the window grows past that.
    var wide = window.matchMedia('(min-width: 961px)');
    var onWide = function () { if (wide.matches && isOpen) close(); };
    if (wide.addEventListener) wide.addEventListener('change', onWide); else wide.addListener(onWide);

    // Drag to dismiss.
    var drag = { active: false, pending: false, startY: 0, startValue: 0, id: null, tracker: null, suppressClick: false };

    panel.addEventListener('pointerdown', function (e) {
      if (!isOpen || e.button > 0 || reducedMotion()) return;
      var onGrabber = !!e.target.closest('[data-menu-grabber]');
      if (!onGrabber && panel.style.touchAction !== 'none') return;
      drag.pending = true;
      drag.id = e.pointerId;
      drag.startY = e.clientY;
      drag.tracker = new VelocityTracker();
      drag.tracker.add(e.clientY);
      if (onGrabber) beginDrag(e);
    });

    function beginDrag(e) {
      drag.active = true;
      drag.pending = false;
      // Catch the sheet wherever it is, even mid-animation.
      drag.startValue = spring.value;
      drag.startY = e.clientY;
      spring.stop();
      try { panel.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    }

    panel.addEventListener('pointermove', function (e) {
      if (e.pointerId !== drag.id) return;
      if (drag.pending) {
        // A little hysteresis so taps on links stay taps.
        if (Math.abs(e.clientY - drag.startY) < 10) return;
        beginDrag(e);
      }
      if (!drag.active) return;
      drag.tracker.add(e.clientY);
      var raw = drag.startValue + (e.clientY - drag.startY);
      var y = raw > 0 ? rubberband(raw, height) : Math.max(raw, -height);
      spring.value = y;
      render(y);
    });

    function endDrag(e) {
      if (e.pointerId !== drag.id) return;
      drag.pending = false;
      if (!drag.active) return;
      drag.active = false;
      drag.suppressClick = true;
      setTimeout(function () { drag.suppressClick = false; }, 0);
      var velocity = e.type === 'pointercancel' ? 0 : drag.tracker.velocity();
      var landing = spring.value + project(velocity);
      var flicked = Math.abs(velocity) > 400;
      if (landing < -height / 2) {
        close(velocity, flicked);
      } else {
        // Back to open, carrying the finger's speed; a flick earns a little bounce.
        spring.to(0, { damping: flicked ? 0.8 : 1, response: 0.3, velocity: velocity });
      }
    }
    panel.addEventListener('pointerup', endDrag);
    panel.addEventListener('pointercancel', endDrag);
  })();

  /* ---------------------------------------------------------------------------
     Disclosure height on a spring (FAQ answers, footer columns on phones).
     Clicking again mid-animation reverses from where it is.
  --------------------------------------------------------------------------- */
  function collapsible(details, isLocked) {
    var summary = details.querySelector('summary');
    var body = details.querySelector('[data-collapse-body]');
    if (!summary || !body) return;
    var spring = new Spring({ damping: 1, response: 0.35, precision: 0.5, onUpdate: function (h) { body.style.height = h + 'px'; } });

    summary.addEventListener('click', function (e) {
      if (isLocked && isLocked()) { e.preventDefault(); return; }
      if (reducedMotion()) return;
      e.preventDefault();
      var closing = details.classList.contains('is-closing');
      var opening = !details.open || closing;
      var from = spring.isMoving() ? spring.value : (details.open ? body.offsetHeight : 0);
      spring.set(from);
      if (opening) {
        details.classList.remove('is-closing');
        details.open = true;
        spring.to(body.scrollHeight, { onRest: function () { body.style.height = ''; } });
      } else {
        details.classList.add('is-closing');
        spring.to(0, {
          onRest: function () {
            details.open = false;
            details.classList.remove('is-closing');
            body.style.height = '';
          }
        });
      }
    });
  }

  each('details[data-collapse]', function (d) { collapsible(d); });

  // Footer columns: always open on wider screens, an accordion on phones.
  (function () {
    var cols = document.querySelectorAll('details[data-footer-col]');
    if (!cols.length) return;
    var wideFooter = window.matchMedia('(min-width: 760px)');
    function sync() {
      Array.prototype.forEach.call(cols, function (d) {
        var summary = d.querySelector('summary');
        d.classList.remove('is-closing');
        d.querySelector('[data-collapse-body]').style.height = '';
        d.open = wideFooter.matches;
        if (wideFooter.matches) summary.setAttribute('tabindex', '-1'); else summary.removeAttribute('tabindex');
      });
    }
    Array.prototype.forEach.call(cols, function (d) { collapsible(d, function () { return wideFooter.matches; }); });
    sync();
    if (wideFooter.addEventListener) wideFooter.addEventListener('change', sync); else wideFooter.addListener(sync);
  })();

  /* ---------------------------------------------------------------------------
     Segmented control: the thumb slides on a spring; arrow keys move between tabs.
  --------------------------------------------------------------------------- */
  each('[data-tabs]', function (box) {
    var tabs = Array.prototype.slice.call(box.querySelectorAll('[role="tab"]'));
    var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute('aria-controls')); });
    var thumb = box.querySelector('[data-tabs-thumb]');
    var current = Math.max(0, tabs.findIndex(function (t) { return t.getAttribute('aria-selected') === 'true'; }));
    var spring = new Spring({ damping: 1, response: 0.35, precision: 0.2, onUpdate: function (x) {
      if (thumb) thumb.style.transform = 'translate3d(' + x + 'px,0,0)';
    } });

    function place(animate) {
      if (!thumb) return;
      var tab = tabs[current];
      thumb.style.width = tab.offsetWidth + 'px';
      if (animate) spring.to(tab.offsetLeft); else spring.set(tab.offsetLeft);
    }

    function select(index, focus) {
      current = (index + tabs.length) % tabs.length;
      tabs.forEach(function (t, i) {
        var on = i === current;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        if (panels[i]) panels[i].hidden = !on;
      });
      if (focus) tabs[current].focus();
      place(true);
    }

    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(i, false); });
      t.addEventListener('keydown', function (e) {
        var keys = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: tabs.length - 1 };
        if (!(e.key in keys)) return;
        e.preventDefault();
        select(keys[e.key], true);
      });
    });

    place(false);
    window.addEventListener('resize', function () { place(false); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { place(false); });
  });

  /* ---------------------------------------------------------------------------
     Pricing calculator: 5% commission, rounded down to the whole rupee.
  --------------------------------------------------------------------------- */
  function rupees(n) {
    return 'Rs ' + String(Math.max(0, Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  each('[data-calculator]', function (calc) {
    var input = calc.querySelector('input');
    var total = calc.querySelector('[data-calc-total]');
    var vendor = calc.querySelector('[data-calc-vendor]');
    var fee = calc.querySelector('[data-calc-fee]');
    var hint = calc.querySelector('[data-calc-hint]');
    var defaultHint = hint ? hint.textContent : '';

    function update() {
      var price = Math.floor(Number(input.value));
      if (!isFinite(price) || price < 0) price = 0;
      var commission = Math.floor(price * 0.05);
      total.textContent = rupees(price);
      vendor.textContent = rupees(price - commission);
      fee.textContent = rupees(commission);
      if (!hint) return;
      var tooLow = input.value !== '' && price < 1000;
      hint.textContent = tooLow ? 'Listings start at Rs 1,000. Try a bigger bundle, or combine items into one listing.' : defaultHint;
      hint.classList.toggle('field__hint--warning', tooLow);
    }

    input.addEventListener('input', update);
    update();
  });

  /* ---------------------------------------------------------------------------
     The example listing's payment timer (a demo, so it loops).
  --------------------------------------------------------------------------- */
  each('[data-countdown]', function (el) {
    var start = parseInt(el.getAttribute('data-seconds'), 10) || 1800;
    var out = el.querySelector('[data-countdown-value]');
    var left = start;
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    setInterval(function () {
      if (document.hidden) return;
      left = left <= 0 ? start : left - 1;
      out.textContent = pad(Math.floor(left / 60)) + ':' + pad(left % 60);
    }, 1000);
  });

  /* ---------------------------------------------------------------------------
     Forms: inline validation with a summary, phone numbers tidied to +92 3XX XXXXXXX.
     With a form endpoint set they post to it; without one they open a pre-filled email.
  --------------------------------------------------------------------------- */
  function labelText(field) {
    var label = field.id && document.querySelector('label[for="' + field.id + '"]');
    if (!label) return field.name;
    var copy = label.cloneNode(true);
    each('.field__optional', function (o) { o.remove(); }, copy);
    return copy.textContent.replace(/\s+/g, ' ').trim();
  }

  // Accepts 03001234567, 3001234567, +92 300 1234567, 0092 300-1234567 and similar.
  function normalisePhone(value) {
    var digits = value.replace(/[^\d+]/g, '').replace(/^\+/, '').replace(/^0092/, '92');
    if (/^92/.test(digits) && digits.length === 12) digits = digits.slice(2);
    else if (/^0/.test(digits) && digits.length === 11) digits = digits.slice(1);
    if (!/^3\d{9}$/.test(digits)) return null;
    return '+92 ' + digits.slice(0, 3) + ' ' + digits.slice(3);
  }

  function validateField(field) {
    var value = (field.value || '').trim();
    var name = labelText(field);
    if (field.type === 'checkbox') {
      return field.required && !field.checked ? 'Tick this box so we can reply to you' : '';
    }
    if (!value) {
      if (!field.required) return '';
      if (field.tagName === 'SELECT') return 'Choose ' + name.charAt(0).toLowerCase() + name.slice(1);
      if (field.type === 'email') return 'Enter your email address';
      if (field.hasAttribute('data-phone')) return 'Enter your mobile number';
      if (field.tagName === 'TEXTAREA') return 'Write a short message';
      return 'Enter ' + (/^your /i.test(name) ? name.charAt(0).toLowerCase() + name.slice(1) : name.toLowerCase());
    }
    if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      return 'Enter an email address like name@example.com';
    }
    if (field.hasAttribute('data-phone') && !normalisePhone(value)) {
      return 'Enter a Pakistani mobile number, like 0300 1234567';
    }
    if (field.type === 'number' && value) {
      var min = field.getAttribute('min');
      if (!/^\d+$/.test(value) || (min && Number(value) < Number(min))) return 'Enter a whole number';
    }
    return '';
  }

  function showFieldError(field, message) {
    var wrapper = field.closest('.field');
    var id = field.id + '-error';
    var existing = document.getElementById(id);
    var describedBy = (field.getAttribute('aria-describedby') || '').split(' ').filter(function (x) { return x && x !== id; });
    if (message) {
      if (!existing) {
        existing = document.createElement('p');
        existing.className = 'field__error';
        existing.id = id;
        wrapper.appendChild(existing);
      }
      existing.textContent = message;
      field.setAttribute('aria-invalid', 'true');
      describedBy.push(id);
    } else {
      if (existing) existing.remove();
      field.removeAttribute('aria-invalid');
    }
    if (describedBy.length) field.setAttribute('aria-describedby', describedBy.join(' '));
    else field.removeAttribute('aria-describedby');
  }

  each('form[data-form]', function (form) {
    var fields = Array.prototype.slice.call(form.querySelectorAll('input:not([type="hidden"]), select, textarea'));
    var summary = form.querySelector('[data-form-errors]');
    var list = form.querySelector('[data-form-error-list]');
    var done = form.querySelector('[data-form-done]');
    var submit = form.querySelector('[type="submit"]');
    var attempted = false;

    fields.forEach(function (field) {
      // Check a field when the person leaves it, then live while they fix it.
      field.addEventListener('blur', function () {
        if (field.hasAttribute('data-phone')) {
          var tidy = normalisePhone(field.value);
          if (tidy) field.value = tidy.replace(/^\+92 /, '');
        }
        if (attempted || field.value.trim()) showFieldError(field, validateField(field));
      });
      var live = function () {
        if (field.getAttribute('aria-invalid') === 'true') showFieldError(field, validateField(field));
      };
      field.addEventListener('input', live);
      field.addEventListener('change', live);
    });

    function lines() {
      return fields.map(function (field) {
        if (field.type === 'checkbox') return 'Happy to be contacted: ' + (field.checked ? 'yes' : 'no');
        var value = field.value.trim();
        if (!value) return null;
        if (field.hasAttribute('data-phone')) value = normalisePhone(value) || value;
        return labelText(field) + ': ' + value;
      }).filter(Boolean);
    }

    function finish(title, text) {
      form.querySelector('.form__grid').hidden = true;
      form.querySelector('.form__actions').hidden = true;
      if (summary) summary.hidden = true;
      if (title) done.querySelector('[data-form-done-title]').textContent = title;
      if (text) done.querySelector('[data-form-done-text]').innerHTML = text;
      done.hidden = false;
      done.focus();
    }

    function openEmail() {
      var to = form.getAttribute('data-form-email');
      var subject = form.getAttribute('data-form-subject');
      var org = form.querySelector('[autocomplete="organization"]');
      var who = org && org.value.trim() ? org.value.trim() : (form.querySelector('[autocomplete="name"]') || {}).value;
      if (who) subject += ': ' + who.trim();
      var body = lines().join('\n') + '\n\nSent from the Rizq Rasan website.';
      window.location.href = 'mailto:' + to + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
      finish('Your email is ready to send',
        'We opened your email app with your details filled in. Press send there and we will reply within one working day. ' +
        'If nothing opened, email us at <a href="mailto:' + to + '">' + to + '</a>.');
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      attempted = true;
      var errors = [];
      fields.forEach(function (field) {
        var message = validateField(field);
        showFieldError(field, message);
        if (message) errors.push({ field: field, message: message });
      });

      if (errors.length) {
        list.innerHTML = '';
        errors.forEach(function (err) {
          var li = document.createElement('li');
          var a = document.createElement('a');
          a.href = '#' + err.field.id;
          a.textContent = err.message;
          a.addEventListener('click', function (ev) { ev.preventDefault(); err.field.focus(); });
          li.appendChild(a);
          list.appendChild(li);
        });
        summary.hidden = false;
        summary.focus();
        return;
      }
      summary.hidden = true;

      fields.forEach(function (field) {
        if (field.hasAttribute('data-phone') && field.value.trim()) field.value = normalisePhone(field.value);
      });

      var action = form.getAttribute('action');
      if (!action) { openEmail(); return; }

      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      fetch(action, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } })
        .then(function (res) {
          if (!res.ok) throw new Error('Form service returned ' + res.status);
          finish();
        })
        .catch(function () { openEmail(); })
        .then(function () { submit.disabled = false; submit.removeAttribute('aria-busy'); });
    });
  });

  /* ---------------------------------------------------------------------------
     Policy pages: "On this page" list built from the headings, with the current
     section highlighted while reading.
  --------------------------------------------------------------------------- */
  (function () {
    var toc = document.querySelector('[data-toc]');
    var source = document.querySelector('[data-toc-source]');
    if (!toc || !source) return;
    var headings = Array.prototype.filter.call(source.querySelectorAll('h2'), function (h) { return h.id; });
    if (headings.length < 3) return;
    var list = toc.querySelector('[data-toc-list]');
    var links = headings.map(function (h) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent;
      li.appendChild(a);
      list.appendChild(li);
      return a;
    });
    toc.hidden = false;

    var active = -1;
    var pending = false;
    function spy() {
      pending = false;
      var offset = (header ? header.offsetHeight : 0) + 48;
      var index = 0;
      for (var i = 0; i < headings.length; i++) {
        if (headings[i].getBoundingClientRect().top - offset <= 0) index = i;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) index = headings.length - 1;
      if (index === active) return;
      if (active >= 0) links[active].removeAttribute('aria-current');
      links[index].setAttribute('aria-current', 'true');
      active = index;
    }
    window.addEventListener('scroll', function () {
      if (!pending) { pending = true; requestAnimationFrame(spy); }
    }, { passive: true });
    spy();
  })();
  /* ---------------------------------------------------------------------------
     Language: English by default. The اردو button translates the page into
     Urdu with Google Translate, which is only loaded once someone asks for it.
     The choice is remembered in Google's "googtrans" cookie, so later pages
     open in Urdu too. The switch is smooth: the page fades while Google works,
     the layout flips to right to left only once the Urdu text has arrived, and
     if Google can't be reached the page simply stays in English with a note.
  --------------------------------------------------------------------------- */
  (function () {
    var toggles = document.querySelectorAll('[data-lang-toggle]');
    if (!toggles.length) {
      root.classList.remove('lang-pending');
      return;
    }

    var SCRIPTS = [
      'https://translate.googleapis.com/translate_a/element.js?cb=rizqTranslateInit',
      'https://translate.google.com/translate_a/element.js?cb=rizqTranslateInit'
    ];
    var TIMEOUT = 12000;
    var started = false, finished = false, timer = 0;

    function wantsUrdu() { return /(?:^|;\s*)googtrans=\/en\/ur(?:;|$)/.test(document.cookie); }

    // Google may store its cookie on the host, on ".host" and on parent domains.
    function cookieDomains() {
      var host = location.hostname, list = [''];
      if (host.indexOf('.') > 0 && !/^\d+(\.\d+){3}$/.test(host)) {
        list.push(host, '.' + host);
        var parts = host.split('.');
        for (var i = 1; i < parts.length - 1; i++) list.push('.' + parts.slice(i).join('.'));
      }
      return list;
    }
    function setCookie(value) {
      var expire = value ? '' : '; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      cookieDomains().forEach(function (d) {
        document.cookie = 'googtrans=' + value + '; path=/' + (d ? '; domain=' + d : '') + expire + '; SameSite=Lax';
      });
    }

    function setButtons(state) {
      // state: 'en' (showing English), 'loading', 'ur' (showing Urdu)
      Array.prototype.forEach.call(toggles, function (b) {
        var urdu = state === 'ur';
        b.textContent = urdu ? 'English' : 'اردو';
        b.setAttribute('lang', urdu ? 'en' : 'ur');
        b.setAttribute('aria-label', urdu ? 'Read in English' : 'اردو میں پڑھیں، Read in Urdu');
        b.setAttribute('aria-pressed', urdu ? 'true' : 'false');
        if (state === 'loading') b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
      });
    }

    function loadUrduFont() {
      if (document.getElementById('urdu-font')) return;
      var font = document.createElement('link');
      font.id = 'urdu-font';
      font.rel = 'stylesheet';
      font.href = 'https://fonts.googleapis.com/css2?family=Noto+Nastaliq+Urdu:wght@400;700&display=swap';
      document.head.appendChild(font);
    }

    function showNote(html, kind) {
      var note = document.querySelector('.translate-note');
      if (!note) {
        note = document.createElement('p');
        note.className = 'translate-note notranslate';
        note.setAttribute('translate', 'no');
        note.setAttribute('role', 'status');
        var main = document.getElementById('main');
        main.parentNode.insertBefore(note, main);
      }
      note.classList.toggle('translate-note--problem', kind === 'problem');
      note.setAttribute('lang', kind === 'problem' ? 'en' : 'ur');
      note.setAttribute('dir', kind === 'problem' ? 'ltr' : 'rtl');
      note.innerHTML = html;
      var back = note.querySelector('[data-lang-english]');
      if (back) back.addEventListener('click', toEnglish);
      var close = note.querySelector('[data-note-close]');
      if (close) close.addEventListener('click', function () { note.remove(); });
    }

    // Google has finished: flip the layout and fade the page back in.
    function urduReady() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      root.setAttribute('lang', 'ur');
      root.setAttribute('dir', 'rtl');
      root.classList.add('lang-ur');
      root.classList.remove('lang-pending', 'lang-loading');
      setButtons('ur');
      showNote('یہ صفحہ خودکار طور پر اردو میں ترجمہ کیا گیا ہے۔ سرکاری متن انگریزی میں ہے۔' +
        '<button type="button" lang="en" dir="ltr" data-lang-english>English</button>', 'info');
      window.dispatchEvent(new Event('resize'));
    }

    // Google could not be reached: stay in English, no reload, and say why.
    function urduFailed() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      setCookie('');
      root.classList.remove('lang-pending', 'lang-loading', 'lang-ur');
      root.setAttribute('lang', 'en');
      root.setAttribute('dir', 'ltr');
      setButtons('en');
      showNote('Urdu translation couldn\'t load. Google Translate may be blocked by your network or an ad blocker. Please try again later.' +
        '<button type="button" data-note-close>Close</button>', 'problem');
    }

    function translated() {
      var h1 = document.querySelector('h1');
      return root.classList.contains('translated-rtl') && (!h1 || /[؀-ۿ]/.test(h1.textContent));
    }

    // Watch for Google's work landing in the page.
    new MutationObserver(function () {
      if (!finished && started && translated()) urduReady();
    }).observe(root, { attributes: true, attributeFilter: ['class'], subtree: false });
    var h1 = document.querySelector('h1');
    if (h1) new MutationObserver(function () {
      if (!finished && started && translated()) urduReady();
    }).observe(h1, { childList: true, subtree: true, characterData: true });

    function pickUrdu() {
      var tries = 0;
      (function attempt() {
        if (finished) return;
        var combo = document.querySelector('select.goog-te-combo');
        if (combo && combo.options.length > 1) {
          if (combo.value !== 'ur') {
            combo.value = 'ur';
            combo.dispatchEvent(new Event('change'));
          }
          return;
        }
        if (++tries < 60) setTimeout(attempt, 100);
      })();
    }

    function loadScript(index) {
      if (index >= SCRIPTS.length) { urduFailed(); return; }
      var script = document.createElement('script');
      script.src = SCRIPTS[index];
      script.async = true;
      script.onerror = function () { script.remove(); loadScript(index + 1); };
      document.body.appendChild(script);
    }

    function startTranslation() {
      if (started) { pickUrdu(); return; }
      started = true;
      finished = false;
      setButtons('loading');
      root.classList.add('lang-loading');
      loadUrduFont();
      timer = setTimeout(urduFailed, TIMEOUT);
      var holder = document.createElement('div');
      holder.id = 'google_translate_element';
      holder.hidden = true;
      document.body.appendChild(holder);
      window.rizqTranslateInit = function () {
        try {
          new window.google.translate.TranslateElement({ pageLanguage: 'en', includedLanguages: 'ur', autoDisplay: false }, 'google_translate_element');
          pickUrdu();
        } catch (err) { urduFailed(); }
      };
      loadScript(0);
    }

    function toUrdu() {
      setCookie('/en/ur');
      startTranslation();
    }

    // Undoing Google's changes reliably needs a fresh copy of the page.
    // Fade out first so the reload feels like a page turn, not a crash.
    function toEnglish() {
      setCookie('');
      root.classList.add('lang-loading');
      setTimeout(function () { location.reload(); }, reducedMotion() ? 0 : 160);
    }

    Array.prototype.forEach.call(toggles, function (b) {
      b.addEventListener('click', function () {
        if (b.getAttribute('aria-busy') === 'true') return;
        if (root.classList.contains('lang-ur') || wantsUrdu() && finished) toEnglish();
        else toUrdu();
      });
    });

    if (wantsUrdu()) startTranslation();
    else root.classList.remove('lang-pending');
  })();
})();
