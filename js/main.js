/* ==========================================================================
   All Star Players — site behaviour
   Sticky header, accessible mobile menu, scroll reveals, the storefront-sign
   hero ignition, and the small microinteractions. No dependencies.
   ========================================================================== */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  function noMotion() { return reduced.matches; }

  /* ------------------------------------------------------- sticky header */
  var header = document.querySelector('[data-header]');
  if (header) {
    var stuck = false;
    var onScroll = function () {
      var y = window.pageYOffset || document.documentElement.scrollTop;
      var next = y > 12;
      if (next !== stuck) { stuck = next; header.classList.toggle('is-stuck', stuck); }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* --------------------------------------------------------- mobile menu */
  var toggle = document.querySelector('[data-nav-toggle]');
  var nav = document.querySelector('[data-nav]');
  if (toggle && nav) {
    var open = false;
    var lastFocus = null;

    function focusables() {
      return nav.querySelectorAll('a[href], button:not([disabled])');
    }
    function setOpen(next) {
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
    }
    function onKey(e) {
      if (e.key === 'Escape') { setOpen(false); return; }
      if (e.key !== 'Tab') return;
      var f = focusables();
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    toggle.addEventListener('click', function () { setOpen(!open); });
    nav.addEventListener('click', function (e) {
      if (open && e.target.closest('a')) setOpen(false);
    });
    window.addEventListener('resize', function () {
      if (open && window.innerWidth > 900) setOpen(false);
    });
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

  /* ------------------------------------- WOW: the storefront sign lights up */
  var hero = document.querySelector('[data-hero]');
  if (hero) {
    var light = function () { hero.classList.add('is-lit'); };
    if (noMotion()) {
      light();
    } else {
      var shot = hero.querySelector('.hero__shot img');
      var start = function () { window.setTimeout(light, 240); };
      if (shot && !shot.complete) {
        shot.addEventListener('load', start, { once: true });
        shot.addEventListener('error', start, { once: true });
        window.setTimeout(light, 2200);            /* never hold the reveal hostage */
      } else { start(); }
    }
  }

  /* ------------------------------------------------------- back to top */
  var toTop = document.querySelector('[data-to-top]');
  if (toTop) {
    toTop.addEventListener('click', function (e) {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: noMotion() ? 'auto' : 'smooth' });
      var skip = document.querySelector('.skip-link');
      if (skip) skip.focus({ preventScroll: true });
    });
  }

  /* -------------------------------------------------- sticky mobile CTA */
  var mcta = document.querySelector('[data-mobile-cta]');
  if (mcta) {
    var tick = function () {
      var y = window.pageYOffset || document.documentElement.scrollTop;
      var docH = document.documentElement.scrollHeight;
      var nearEnd = (y + window.innerHeight) > (docH - 260);
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
