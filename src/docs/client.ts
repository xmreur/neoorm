/** Docs site client script, served as a static asset. */
export const DOCS_JS = String.raw`
(function () {
  "use strict";

  var root = document.documentElement;
  var body = document.body;
  var docsData = window.__NEOORM_DOCS__ || { pages: [], slug: "" };
  var THEME_KEY = "neoorm-docs-theme";
  var PM_KEY = "neoorm-docs-pm";
  var PACKAGE_MANAGERS = ["npm", "yarn", "pnpm", "bun"];
  var RECENT_KEY = "neoorm-docs-recent";
  var systemMedia = window.matchMedia("(prefers-color-scheme: dark)");
  var isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || "");
  var shortcut = document.querySelector(".search-trigger kbd");
  if (shortcut) {
    shortcut.textContent = isMac ? "\u2318K" : "Ctrl K";
  }

  function safeStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      /* storage can be disabled */
    }
  }

  function safeStorageRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (error) {
      /* storage can be disabled */
    }
  }

  function storedTheme() {
    var value = safeStorageGet(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  }

  function effectiveTheme() {
    return storedTheme() || (systemMedia.matches ? "dark" : "light");
  }

  function updateThemeButtons() {
    var theme = effectiveTheme();
    var mode = storedTheme() || "system";
    root.setAttribute("data-theme-mode", mode);
    var buttons = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < buttons.length; i += 1) {
      var button = buttons[i];
      button.setAttribute(
        "aria-label",
        "Theme: " + mode + ". Switch to " + (theme === "dark" ? "light" : "dark") + ".",
      );
      button.setAttribute("title", "Theme: " + mode);
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", theme === "dark" ? "#111114" : "#F4F3EF");
    }
  }

  function applyTheme() {
    var theme = effectiveTheme();
    root.setAttribute("data-theme", theme);
    root.style.colorScheme = theme;
    updateThemeButtons();
  }

  function setTheme(mode) {
    if (mode === "system") {
      safeStorageRemove(THEME_KEY);
    } else {
      safeStorageSet(THEME_KEY, mode);
    }
    applyTheme();
  }

  function cycleTheme() {
    var stored = storedTheme();
    if (!stored) {
      setTheme("light");
      return;
    }
    if (stored === "light") {
      setTheme("dark");
      return;
    }
    setTheme("system");
  }

  applyTheme();

  function currentPackageManager() {
    var stored = safeStorageGet(PM_KEY);
    return PACKAGE_MANAGERS.indexOf(stored) >= 0 ? stored : "bun";
  }

  function applyPackageManager(pm) {
    var nodes = document.querySelectorAll("[data-pm-code]");
    for (var i = 0; i < nodes.length; i += 1) {
      var text = nodes[i].getAttribute("data-" + pm);
      if (text !== null) {
        nodes[i].textContent = text;
      }
    }
    var tabs = document.querySelectorAll("[data-pm-choice]");
    for (var tabIndex = 0; tabIndex < tabs.length; tabIndex += 1) {
      var tab = tabs[tabIndex];
      var selected = tab.getAttribute("data-pm-choice") === pm;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
    }
  }

  function setPackageManager(pm) {
    safeStorageSet(PM_KEY, pm);
    applyPackageManager(pm);
  }

  applyPackageManager(currentPackageManager());

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    var tab = target.closest("[data-pm-choice]");
    if (!tab) {
      return;
    }
    var choice = tab.getAttribute("data-pm-choice");
    if (PACKAGE_MANAGERS.indexOf(choice) >= 0) {
      setPackageManager(choice);
    }
  });

  document.addEventListener("keydown", function (event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    var tab = target.closest("[data-pm-choice]");
    if (!tab) {
      return;
    }
    var index = PACKAGE_MANAGERS.indexOf(tab.getAttribute("data-pm-choice"));
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
      return;
    }
    event.preventDefault();
    var next = event.key === "ArrowRight" ? index + 1 : index - 1;
    if (next < 0) {
      next = PACKAGE_MANAGERS.length - 1;
    }
    if (next >= PACKAGE_MANAGERS.length) {
      next = 0;
    }
    var pm = PACKAGE_MANAGERS[next];
    setPackageManager(pm);
    var list = tab.closest("[role='tablist']");
    var nextTab = list ? list.querySelector('[data-pm-choice="' + pm + '"]') : null;
    if (nextTab) {
      nextTab.focus();
    }
  });

  systemMedia.addEventListener("change", function () {
    if (!storedTheme()) {
      applyTheme();
    }
  });

  var themeButtons = document.querySelectorAll("[data-theme-toggle]");
  for (var themeIndex = 0; themeIndex < themeButtons.length; themeIndex += 1) {
    themeButtons[themeIndex].addEventListener("click", cycleTheme);
  }

  /* Mobile navigation */
  var navToggle = document.querySelector("[data-nav-toggle]");
  var navBackdrop = document.querySelector("[data-nav-backdrop]");
  var navClose = document.querySelector("[data-nav-close]");
  var sidebar = document.getElementById("sidebar");

  function closeNav() {
    body.classList.remove("nav-open");
    if (navToggle) {
      navToggle.setAttribute("aria-expanded", "false");
    }
  }

  function openNav() {
    body.classList.add("nav-open");
    if (navToggle) {
      navToggle.setAttribute("aria-expanded", "true");
    }
    var firstLink = sidebar ? sidebar.querySelector("a") : null;
    if (firstLink) {
      firstLink.focus();
    }
  }

  if (navToggle) {
    navToggle.addEventListener("click", function () {
      if (body.classList.contains("nav-open")) {
        closeNav();
      } else {
        openNav();
      }
    });
  }
  if (navBackdrop) {
    navBackdrop.addEventListener("click", closeNav);
  }
  if (navClose) {
    navClose.addEventListener("click", closeNav);
  }
  if (sidebar) {
    sidebar.addEventListener("click", function (event) {
      var target = event.target;
      if (target && target.closest && target.closest("a")) {
        closeNav();
      }
    });
  }
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && body.classList.contains("nav-open")) {
      closeNav();
    }
  });
  window.addEventListener("resize", function () {
    if (window.innerWidth > 900) {
      closeNav();
    }
  });

  /* Table of contents scroll spy */
  var tocLinks = Array.prototype.slice.call(
    document.querySelectorAll(".toc-link[href^='#']"),
  );
  if (tocLinks.length > 0) {
    var tocHeadings = tocLinks
      .map(function (link) {
        var id = link.getAttribute("href").slice(1);
        return document.getElementById(id);
      })
      .filter(Boolean);
    var activeTocId = "";
    var tocFrame = 0;

    function setActiveToc(id) {
      if (id === activeTocId) {
        return;
      }
      activeTocId = id;
      for (var i = 0; i < tocLinks.length; i += 1) {
        var link = tocLinks[i];
        var isActive = link.getAttribute("href") === "#" + id;
        link.classList.toggle("active", isActive);
        if (isActive) {
          link.setAttribute("aria-current", "location");
        } else {
          link.removeAttribute("aria-current");
        }
      }
    }

    function updateToc() {
      tocFrame = 0;
      if (tocHeadings.length === 0) {
        return;
      }
      var offset = window.scrollY + 110;
      var current = tocHeadings[0];
      for (var i = 0; i < tocHeadings.length; i += 1) {
        if (tocHeadings[i].offsetTop <= offset) {
          current = tocHeadings[i];
        }
      }
      setActiveToc(current.id);
    }

    function requestTocUpdate() {
      if (tocFrame) {
        return;
      }
      tocFrame = window.requestAnimationFrame(updateToc);
    }

    window.addEventListener("scroll", requestTocUpdate, { passive: true });
    window.addEventListener("resize", requestTocUpdate);
    updateToc();
  }

  /* Copy code */
  function fallbackCopy(text) {
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    var copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (error) {
      copied = false;
    }
    document.body.removeChild(textarea);
    return copied;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () {
        if (!fallbackCopy(text)) {
          throw new Error("copy failed");
        }
      });
    }
    if (fallbackCopy(text)) {
      return Promise.resolve();
    }
    return Promise.reject(new Error("copy failed"));
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    function syncSpecimen(specimen, tabId, dialectId) {
      specimen.setAttribute("data-active-tab", tabId);
      specimen.setAttribute("data-active-dialect", dialectId);
      var heroTabs = specimen.querySelectorAll("[data-hero-tab]");
      for (var t = 0; t < heroTabs.length; t += 1) {
        var active = heroTabs[t].getAttribute("data-hero-tab") === tabId;
        heroTabs[t].setAttribute("aria-selected", active ? "true" : "false");
        heroTabs[t].tabIndex = active ? 0 : -1;
      }
      var dialectButtons = specimen.querySelectorAll("[data-hero-dialect]");
      for (var d = 0; d < dialectButtons.length; d += 1) {
        var isDialect =
          dialectButtons[d].getAttribute("data-hero-dialect") === dialectId;
        dialectButtons[d].setAttribute(
          "aria-pressed",
          isDialect ? "true" : "false"
        );
      }
      var heroPanels = specimen.querySelectorAll("[data-hero-panel]");
      for (var p = 0; p < heroPanels.length; p += 1) {
        var panelTab = heroPanels[p].getAttribute("data-hero-panel");
        var panelDialect = heroPanels[p].getAttribute(
          "data-hero-dialect-panel"
        );
        var isPanelActive =
          panelTab === tabId &&
          (tabId !== "sql" || panelDialect === dialectId);
        heroPanels[p].setAttribute(
          "data-active",
          isPanelActive ? "true" : "false"
        );
        heroPanels[p].setAttribute(
          "aria-hidden",
          isPanelActive ? "false" : "true"
        );
      }
    }
    var specimenTab = target.closest("[data-hero-tab]");
    if (specimenTab) {
      var specimen = specimenTab.closest("[data-hero-specimen]");
      var id = specimenTab.getAttribute("data-hero-tab");
      if (specimen && id) {
        var currentDialect =
          specimen.getAttribute("data-active-dialect") || "pg";
        syncSpecimen(specimen, id, currentDialect);
      }
      return;
    }
    var specimenDialect = target.closest("[data-hero-dialect]");
    if (specimenDialect) {
      var dialectSpecimen = specimenDialect.closest("[data-hero-specimen]");
      var dialect = specimenDialect.getAttribute("data-hero-dialect");
      if (dialectSpecimen && dialect) {
        syncSpecimen(dialectSpecimen, "sql", dialect);
      }
      return;
    }
    var specimenCopy = target.closest("[data-copy-specimen]");
    if (specimenCopy) {
      var container = specimenCopy.closest("[data-hero-specimen]");
      var visiblePanel = container
        ? container.querySelector('[data-hero-panel][data-active="true"] pre')
        : null;
      if (!visiblePanel) {
        return;
      }
      var prevLabel = specimenCopy.textContent;
      copyText(visiblePanel.innerText)
        .then(function () {
          specimenCopy.textContent = "Copied";
          specimenCopy.classList.add("copied");
          window.setTimeout(function () {
            specimenCopy.textContent = prevLabel;
            specimenCopy.classList.remove("copied");
          }, 1600);
        })
        .catch(function () {
          specimenCopy.textContent = "Copy failed";
          window.setTimeout(function () {
            specimenCopy.textContent = prevLabel;
          }, 1600);
        });
      return;
    }
    var button = target.closest("[data-copy]");
    if (!button) {
      return;
    }
    var block = button.closest("[data-pm-block], .code-block");
    var source = block ? block.querySelector("[data-pm-code], pre") : null;
    if (!source) {
      return;
    }
    var original = button.textContent;
    copyText(source.innerText)
      .then(function () {
        button.textContent = "Copied";
        button.classList.add("copied");
        window.setTimeout(function () {
          button.textContent = original;
          button.classList.remove("copied");
        }, 1600);
      })
      .catch(function () {
        button.textContent = "Copy failed";
        window.setTimeout(function () {
          button.textContent = original;
        }, 1600);
      });
  });

  /* Search palette */
  var overlay = document.getElementById("search-overlay");
  var dialog = document.getElementById("search-dialog");
  var input = document.getElementById("search-input");
  var results = document.getElementById("search-results");
  var hint = document.getElementById("search-hint");
  if (!overlay || !dialog || !input || !results || !hint) {
    return;
  }

  var pageBySlug = {};
  for (var pageIndex = 0; pageIndex < docsData.pages.length; pageIndex += 1) {
    pageBySlug[docsData.pages[pageIndex].slug] = docsData.pages[pageIndex];
  }

  var searchOpen = false;
  var searchHits = [];
  var activeIndex = -1;
  var searchTimer = 0;
  var searchController = null;
  var lastQuery = "";
  var searchCache = Object.create(null);
  var lastTrigger = null;

  function resultHref(hit) {
    return "/docs/" + hit.slug + (hit.anchor ? "#" + hit.anchor : "");
  }

  function recentSlugs() {
    var raw = safeStorageGet(RECENT_KEY);
    if (!raw) {
      return [];
    }
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function saveRecent(slug) {
    if (!slug) {
      return;
    }
    var slugs = recentSlugs().filter(function (item) {
      return item !== slug;
    });
    slugs.unshift(slug);
    safeStorageSet(RECENT_KEY, JSON.stringify(slugs.slice(0, 5)));
  }

  function makeResult(hit, index) {
    var link = document.createElement("a");
    link.className = "search-result";
    link.id = "search-option-" + index;
    link.href = resultHref(hit);
    link.setAttribute("role", "option");
    link.setAttribute("aria-selected", "false");

    var title = document.createElement("span");
    title.className = "search-result-title";
    var titleText = document.createElement("span");
    titleText.textContent = hit.heading || hit.title;
    title.appendChild(titleText);
    if (hit.heading) {
      var page = document.createElement("span");
      page.className = "search-result-page";
      page.textContent = hit.title;
      title.appendChild(page);
    }
    link.appendChild(title);

    var excerpt = document.createElement("span");
    excerpt.className = "search-result-excerpt";
    renderHighlighted(excerpt, hit.excerpt, hit.highlights || []);
    link.appendChild(excerpt);

    link.addEventListener("click", function () {
      saveRecent(hit.slug);
    });

    return link;
  }

  function renderHighlighted(element, text, ranges) {
    var position = 0;
    for (var i = 0; i < ranges.length; i += 1) {
      var range = ranges[i];
      if (range.start > position) {
        element.appendChild(
          document.createTextNode(text.slice(position, range.start)),
        );
      }
      var mark = document.createElement("mark");
      mark.textContent = text.slice(range.start, range.end);
      element.appendChild(mark);
      position = range.end;
    }
    if (position < text.length) {
      element.appendChild(document.createTextNode(text.slice(position)));
    }
  }

  function clearResults() {
    results.textContent = "";
    searchHits = [];
    activeIndex = -1;
  }

  function setActive(index) {
    if (searchHits.length === 0) {
      activeIndex = -1;
      input.removeAttribute("aria-activedescendant");
      return;
    }
    activeIndex = Math.max(0, Math.min(index, searchHits.length - 1));
    var options = results.querySelectorAll(".search-result");
    for (var i = 0; i < options.length; i += 1) {
      var option = options[i];
      var isActive = i === activeIndex;
      option.classList.toggle("active", isActive);
      option.setAttribute("aria-selected", isActive ? "true" : "false");
      if (isActive) {
        option.scrollIntoView({ block: "nearest" });
      }
    }
    var active = options[activeIndex];
    if (active) {
      input.setAttribute("aria-activedescendant", active.id);
    }
  }

  function renderHits(hits) {
    clearResults();
    results.setAttribute("aria-expanded", "true");
    if (hits.length === 0) {
      hint.hidden = false;
      hint.innerHTML = "";
      var empty = document.createElement("div");
      empty.className = "search-empty";
      var emptyTitle = document.createElement("div");
      emptyTitle.className = "search-empty-title";
      emptyTitle.textContent = "No results for \u201c" + lastQuery + "\u201d";
      var emptyText = document.createElement("div");
      emptyText.className = "search-empty-text";
      emptyText.textContent =
        "Try a command, a table name, or a query method like findMany.";
      empty.appendChild(emptyTitle);
      empty.appendChild(emptyText);
      hint.appendChild(empty);
      return;
    }
    hint.hidden = true;
    searchHits = hits;
    for (var i = 0; i < hits.length; i += 1) {
      results.appendChild(makeResult(hits[i], i));
    }
    setActive(0);
  }

  function renderGroup(label, pages) {
    if (pages.length === 0) {
      return;
    }
    var heading = document.createElement("div");
    heading.className = "search-group-label";
    heading.textContent = label;
    results.appendChild(heading);
    for (var i = 0; i < pages.length; i += 1) {
      var page = pages[i];
      var link = document.createElement("a");
      link.className = "search-result";
      link.href = "/docs/" + page.slug;
      link.setAttribute("role", "option");
      var title = document.createElement("span");
      title.className = "search-result-title";
      title.textContent = page.title;
      var description = document.createElement("span");
      description.className = "search-result-excerpt";
      description.textContent = page.description || "";
      link.appendChild(title);
      link.appendChild(description);
      results.appendChild(link);
    }
  }

  function renderHome() {
    clearResults();
    results.setAttribute("aria-expanded", "false");
    hint.hidden = true;
    var recent = recentSlugs()
      .map(function (slug) {
        return pageBySlug[slug];
      })
      .filter(Boolean);
    if (recent.length > 0) {
      renderGroup("Recent", recent);
    }
    var recentSlugSet = {};
    for (var recentIndex = 0; recentIndex < recent.length; recentIndex += 1) {
      recentSlugSet[recent[recentIndex].slug] = true;
    }
    var startPages = docsData.pages.filter(function (page) {
      return page.group === "Start here" && !recentSlugSet[page.slug];
    });
    renderGroup("Start here", startPages);
  }

  function setSearchStatus(text) {
    clearResults();
    hint.hidden = false;
    hint.textContent = text;
  }

  function requestSearch(query) {
    if (query === "") {
      renderHome();
      return;
    }
    if (searchCache[query]) {
      renderHits(searchCache[query]);
      return;
    }
    if (searchController) {
      searchController.abort();
    }
    searchController = new AbortController();
    var controller = searchController;
    setSearchStatus("Searching\u2026");
    fetch("/search?q=" + encodeURIComponent(query), {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("Search failed");
        }
        return response.json();
      })
      .then(function (data) {
        if (controller.signal.aborted || query !== lastQuery) {
          return;
        }
        var hits = Array.isArray(data.hits) ? data.hits : [];
        searchCache[query] = hits;
        renderHits(hits);
      })
      .catch(function (error) {
        if (error && error.name === "AbortError") {
          return;
        }
        if (query !== lastQuery) {
          return;
        }
        setSearchStatus("Search is unavailable. Try again.");
      });
  }

  function openSearch(trigger) {
    lastTrigger = trigger || document.activeElement;
    searchOpen = true;
    overlay.hidden = false;
    body.classList.add("search-open");
    input.setAttribute("aria-expanded", "true");
    input.focus();
    input.select();
    if (input.value.trim() === "") {
      renderHome();
    } else {
      lastQuery = input.value.trim();
      requestSearch(lastQuery);
    }
  }

  function closeSearch() {
    searchOpen = false;
    overlay.hidden = true;
    body.classList.remove("search-open");
    input.setAttribute("aria-expanded", "false");
    if (searchController) {
      searchController.abort();
      searchController = null;
    }
    if (lastTrigger && typeof lastTrigger.focus === "function") {
      lastTrigger.focus();
    }
  }

  input.addEventListener("input", function () {
    var query = input.value.trim();
    lastQuery = query;
    window.clearTimeout(searchTimer);
    if (query === "") {
      renderHome();
      return;
    }
    searchTimer = window.setTimeout(function () {
      requestSearch(query);
    }, 120);
  });

  input.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(activeIndex + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(activeIndex - 1);
      return;
    }
    if (event.key === "Enter" && activeIndex >= 0) {
      var active = results.querySelectorAll(".search-result")[activeIndex];
      if (active) {
        event.preventDefault();
        window.location.href = active.getAttribute("href");
      }
    }
  });

  overlay.addEventListener("click", function (event) {
    if (event.target === overlay) {
      closeSearch();
    }
  });

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }
    var closeButton = target.closest("[data-search-close]");
    if (closeButton && searchOpen) {
      event.preventDefault();
      closeSearch();
      return;
    }
    var trigger = target.closest("[data-search-open]");
    if (trigger && !searchOpen) {
      event.preventDefault();
      openSearch(trigger);
    }
  });

  document.addEventListener("keydown", function (event) {
    var isTyping =
      event.target &&
      (event.target.tagName === "INPUT" ||
        event.target.tagName === "TEXTAREA" ||
        event.target.isContentEditable);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (searchOpen) {
        closeSearch();
      } else {
        openSearch(document.activeElement);
      }
      return;
    }
    if (event.key === "/" && !isTyping && !searchOpen) {
      event.preventDefault();
      openSearch(document.activeElement);
      return;
    }
    if (event.key === "Escape" && searchOpen) {
      event.preventDefault();
      closeSearch();
      return;
    }
    if (event.key === "Tab" && searchOpen) {
      var focusable = dialog.querySelectorAll(
        "a[href], button:not([disabled]), input, [tabindex]:not([tabindex='-1'])",
      );
      if (focusable.length === 0) {
        return;
      }
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  if (docsData.slug) {
    saveRecent(docsData.slug);
  }
})();
`;
