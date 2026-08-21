/* ============================================================
   code-walkthrough — runtime engine (chrome only, content-free).
   Pairs with walkthrough.css + octicons-sprite.html.
   Reads the diagram graph from window.WALKTHROUGH.edges (emitted
   by the builder). Code is pre-escaped into <pre><code> by the
   builder, so this file only highlights + wires interactivity.
   ============================================================ */
(function () {
  "use strict";

  /* 1. Syntax highlight (PrismJS already loaded) */
  if (window.Prism) window.Prism.highlightAll();

  /* 2. Collapsible code blocks (toggle label is localized by the builder) */
  var STR = (window.WALKTHROUGH && window.WALKTHROUGH.strings) || {};
  var SHOW = STR.showSource || "show source ▾";
  var HIDE = STR.hide || "hide ▴";
  document.querySelectorAll(".codeblock .ctoggle").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var block = btn.closest(".codeblock");
      var collapsed = block.classList.toggle("collapsed");
      btn.textContent = collapsed ? SHOW : HIDE;
    });
  });

  /* 3. Diagram — SVG connectors between model nodes */
  var EDGES = (window.WALKTHROUGH && window.WALKTHROUGH.edges) || [];
  var svg = document.getElementById("edges");
  if (svg && EDGES.length) {
    var SVGNS = "http://www.w3.org/2000/svg";
    var adj = {};
    EDGES.forEach(function (e) {
      adj[e.from] = adj[e.from] || [];
      adj[e.to] = adj[e.to] || [];
    });

    function center(el, box) {
      var r = el.getBoundingClientRect();
      return {
        x: r.left - box.left + r.width / 2,
        y: r.top - box.top + r.height / 2,
        w: r.width,
        h: r.height,
      };
    }
    function anchor(a, p) {
      var dx = p.x - a.x,
        dy = p.y - a.y;
      var hw = a.w / 2,
        hh = a.h / 2;
      var sx = dx === 0 ? Infinity : hw / Math.abs(dx);
      var sy = dy === 0 ? Infinity : hh / Math.abs(dy);
      var s = Math.min(sx, sy);
      return { x: a.x + dx * s, y: a.y + dy * s };
    }

    var pathEls = [];
    function drawEdges() {
      pathEls.forEach(function (p) {
        p.remove();
      });
      document.querySelectorAll(".edge-label-g").forEach(function (g) {
        g.remove();
      });
      pathEls = [];
      Object.keys(adj).forEach(function (k) {
        adj[k] = [];
      });

      var box = svg.getBoundingClientRect();
      EDGES.forEach(function (e) {
        var aEl = document.getElementById(e.from);
        var bEl = document.getElementById(e.to);
        if (!aEl || !bEl) return;
        var a = center(aEl, box),
          b = center(bEl, box);
        var pa = anchor(a, b),
          pb = anchor(b, a);
        var mx = (pa.x + pb.x) / 2,
          my = (pa.y + pb.y) / 2;
        var cx = (pa.x + pb.x) / 2;
        var d =
          "M " + pa.x + " " + pa.y + " C " + cx + " " + pa.y + ", " +
          cx + " " + pb.y + ", " + pb.x + " " + pb.y;

        var path = document.createElementNS(SVGNS, "path");
        path.setAttribute("d", d);
        path.setAttribute("class", "edge " + (e.cls || "") + (e.thick ? " thick" : ""));
        path.setAttribute("marker-end", "url(#ah)");
        if (e.thick) path.style.strokeWidth = "2.6";
        svg.appendChild(path);
        pathEls.push(path);
        adj[e.from].push(path);
        adj[e.to].push(path);

        if (!e.label) return;
        var g = document.createElementNS(SVGNS, "g");
        g.setAttribute("class", "edge-label-g");
        var txt = document.createElementNS(SVGNS, "text");
        txt.setAttribute("x", mx);
        txt.setAttribute("y", my - 4);
        txt.setAttribute("text-anchor", "middle");
        txt.setAttribute("class", "edge-label");
        txt.textContent = e.label;
        var rect = document.createElementNS(SVGNS, "rect");
        rect.setAttribute("class", "edge-label bg");
        g.appendChild(rect);
        g.appendChild(txt);
        svg.appendChild(g);
        var bb = txt.getBBox();
        rect.setAttribute("x", bb.x - 5);
        rect.setAttribute("y", bb.y - 2);
        rect.setAttribute("width", bb.width + 10);
        rect.setAttribute("height", bb.height + 4);
        rect.setAttribute("rx", 4);
        rect.setAttribute("opacity", ".96");
      });
    }

    drawEdges();
    window.addEventListener("resize", drawEdges);
    window.addEventListener("load", drawEdges);

    document.querySelectorAll(".node").forEach(function (node) {
      node.addEventListener("mouseenter", function () {
        pathEls.forEach(function (p) {
          p.classList.add("fade");
        });
        (adj[node.id] || []).forEach(function (p) {
          p.classList.remove("fade");
          p.classList.add("hot");
        });
      });
      node.addEventListener("mouseleave", function () {
        pathEls.forEach(function (p) {
          p.classList.remove("fade");
          p.classList.remove("hot");
        });
      });
      node.addEventListener("click", function () {
        var t = node.getAttribute("data-target");
        if (!t) return;
        var dest = document.querySelector(t);
        if (dest) dest.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  /* 4. Scrollspy — highlight the active sidebar link */
  var navLinks = Array.prototype.slice.call(document.querySelectorAll("nav.side a.nav"));
  var byHash = {};
  navLinks.forEach(function (a) {
    byHash[a.getAttribute("href")] = a;
  });
  var spy = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          navLinks.forEach(function (a) {
            a.classList.remove("active");
          });
          var a = byHash["#" + en.target.id];
          if (a) a.classList.add("active");
        }
      });
    },
    { rootMargin: "-10% 0px -78% 0px", threshold: 0 }
  );
  document.querySelectorAll("main section[id]").forEach(function (s) {
    spy.observe(s);
  });
})();
