/* ==========================================================================
   All Star Players / site behaviour
   Sticky header, the phone menu, scroll reveals, and the video that runs
   behind the top of the home page. No dependencies.
   ========================================================================== */
(function () {
  'use strict';

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  function noMotion() { return reduced.matches; }

  /* ------------------------------------------------------- sticky header */
  var header = document.querySelector('[data-header]');
  if (header) {
    var stuck = false;
    var onScroll = function () {
      var next = (window.pageYOffset || document.documentElement.scrollTop) > 12;
      if (next !== stuck) { stuck = next; header.classList.toggle('is-stuck', stuck); }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ----------------------------------------------------------- the menu */
  var toggle = document.querySelector('[data-nav-toggle]');
  var nav = document.querySelector('[data-nav]');
  if (toggle && nav) {
    var open = false;
    var lastFocus = null;

    var focusables = function () { return nav.querySelectorAll('a[href], button:not([disabled])'); };

    var setOpen = function (next) {
      open = next;
      nav.classList.toggle('is-open', open);
      document.body.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      if (open) {
        lastFocus = document.activeElement;
        var f = focusables();
        if (f.length) f[0].focus();
        document.addEventListener('keydown', onKey);
      } else {
        document.removeEventListener('keydown', onKey);
        if (lastFocus && lastFocus.focus) lastFocus.focus();
      }
    };
    var onKey = function (e) {
      if (e.key === 'Escape') { setOpen(false); return; }
      if (e.key !== 'Tab') return;
      var f = focusables();
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    toggle.addEventListener('click', function () { setOpen(!open); });
    nav.addEventListener('click', function (e) { if (open && e.target.closest('a')) setOpen(false); });
    window.addEventListener('resize', function () { if (open && window.innerWidth > 900) setOpen(false); });
  }

  /* ------------------------------------------------------- scroll reveal */
  var revealSel = '[data-reveal], .reveal-lines, .star-wipe, [data-foil], [data-inview]';
  var items = document.querySelectorAll(revealSel);

  if (!('IntersectionObserver' in window) || noMotion()) {
    Array.prototype.forEach.call(items, function (el) { el.classList.add('is-in'); });
    Array.prototype.forEach.call(document.querySelectorAll('.star-wipe'), function (el) {
      el.classList.add('is-done');
    });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        el.classList.add('is-in');
        if (el.classList.contains('star-wipe')) {
          window.setTimeout(function () { el.classList.add('is-done'); }, 1800);
        }
        io.unobserve(el);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });
    Array.prototype.forEach.call(items, function (el) { io.observe(el); });
  }

  /* ═══════════════════════════════════════════ the video behind the top ══
     Rules it follows, in order:
       starts on its own, always silent, always looping, inline on phones
       the still photograph underneath carries the header until it is running,
         and stays put if the file never loads
       sound only ever comes on when somebody presses the button, and goes
         back off when they press it again
       it never downloads on a data saver, a 2g connection, or for anyone who
         asked their system to reduce motion. Those visitors get a play button
       it stops when it scrolls out of sight or the tab goes away, so it is
         not burning battery behind the rest of the page
     ══════════════════════════════════════════════════════════════════════ */
  var hero = document.querySelector('[data-hero]');
  var video = hero && hero.querySelector('[data-hero-video]');

  if (video) {
    var controls = hero.querySelector('[data-hero-controls]');
    var playBtn = hero.querySelector('[data-hero-play]');
    var soundBtn = hero.querySelector('[data-hero-sound]');
    var playLabel = playBtn && playBtn.querySelector('[data-label]');
    var soundLabel = soundBtn && soundBtn.querySelector('[data-label]');

    var userPaused = false;   /* set only by the pause button */
    var dead = false;         /* the file could not be played */
    var loaded = false;

    /* silent before anything else happens, both ways, for iOS */
    video.muted = true;
    video.defaultMuted = true;
    video.volume = 0.55;

    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    var thrifty = !!(conn && (conn.saveData || /(^|-)2g$/.test(conn.effectiveType || '')));
    var autoAllowed = !noMotion() && !thrifty;

    function load() {
      if (loaded || dead) return;
      loaded = true;
      var narrow = window.innerWidth <= 760;
      var src = narrow ? video.getAttribute('data-src-narrow') : video.getAttribute('data-src-wide');
      if (!src) { fail(); return; }
      video.setAttribute('src', src);
      video.load();
    }

    function start() {
      if (dead) return;
      load();
      var p = video.play();
      if (p && p.catch) p.catch(function () { syncPlay(); });
    }

    function fail() {
      dead = true;
      hero.classList.remove('is-video-ready');
      if (controls) controls.hidden = true;
    }

    function syncPlay() {
      var running = !video.paused && !video.ended;
      if (playBtn) {
        playBtn.setAttribute('aria-pressed', running ? 'true' : 'false');
        playBtn.setAttribute('aria-label', running ? 'Pause the store video' : 'Play the store video');
        playBtn.classList.toggle('is-playing', running);
        if (playLabel) playLabel.textContent = running ? 'Pause' : 'Play';
      }
    }
    function syncSound() {
      var on = !video.muted;
      if (soundBtn) {
        soundBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        soundBtn.setAttribute('aria-label', on ? 'Turn the sound off' : 'Turn the sound on');
        soundBtn.classList.toggle('is-loud', on);
        if (soundLabel) soundLabel.textContent = on ? 'Sound on' : 'Sound off';
      }
    }

    video.addEventListener('playing', function () {
      hero.classList.add('is-video-ready');
      if (controls) controls.hidden = false;
      syncPlay();
    });
    video.addEventListener('pause', syncPlay);
    video.addEventListener('volumechange', syncSound);
    video.addEventListener('error', fail);
    video.addEventListener('stalled', function () { if (!video.readyState) fail(); });

    if (playBtn) {
      playBtn.addEventListener('click', function () {
        if (video.paused) { userPaused = false; start(); }
        else { userPaused = true; video.pause(); }
        syncPlay();
      });
    }
    if (soundBtn) {
      soundBtn.addEventListener('click', function () {
        if (video.muted) {
          video.muted = false;
          if (video.paused) { userPaused = false; start(); }
        } else {
          video.muted = true;
        }
        syncSound();
      });
    }

    /* stop while it is off screen or the tab is in the background */
    if ('IntersectionObserver' in window) {
      var vio = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (dead) return;
          if (e.isIntersecting) {
            if (!userPaused && autoAllowed && video.paused) start();
          } else if (!video.paused) {
            video.pause();
          }
        });
      }, { threshold: 0.12 });
      vio.observe(video);
    }
    document.addEventListener('visibilitychange', function () {
      if (dead) return;
      if (document.hidden) { if (!video.paused) video.pause(); }
      else if (!userPaused && autoAllowed) start();
    });

    syncPlay();
    syncSound();

    if (autoAllowed) {
      /* let the header photo and the fonts land first */
      var kick = function () { window.setTimeout(start, 120); };
      if (document.readyState === 'complete') kick();
      else window.addEventListener('load', kick, { once: true });
    } else if (controls) {
      controls.hidden = false;   /* nothing is running, so offer the button */
    }
  }

  /* --------------------------------------------------------- back to top */
  var toTop = document.querySelector('[data-to-top]');
  if (toTop) {
    toTop.addEventListener('click', function (e) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: noMotion() ? 'auto' : 'smooth' });
      var skip = document.querySelector('.skip-link');
      if (skip) skip.focus({ preventScroll: true });
    });
  }

  /* ------------------------------------------------ the bar on phones */
  var mcta = document.querySelector('[data-mobile-cta]');
  if (mcta) {
    var tick = function () {
      var y = window.pageYOffset || document.documentElement.scrollTop;
      var nearEnd = (y + window.innerHeight) > (document.documentElement.scrollHeight - 300);
      mcta.classList.toggle('is-visible', y > 520 && !nearEnd);
    };
    window.addEventListener('scroll', tick, { passive: true });
    window.addEventListener('resize', tick, { passive: true });
    tick();
  }

  /* ------------------------------------------------------------ the year */
  Array.prototype.forEach.call(document.querySelectorAll('[data-year]'), function (el) {
    el.textContent = new Date().getFullYear();
  });
})();
