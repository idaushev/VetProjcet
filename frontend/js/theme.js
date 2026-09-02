/* theme.js — вынесено из index.html.
 *
 * Инлайновый <script> в странице заставлял CSP держать
 * script-src 'unsafe-inline'. Код не менялся, только переехал.
 */
window.VetTheme = (function () {
      function isDark(mode) {
        return mode === 'dark' || (mode === 'auto' && window.matchMedia
          && window.matchMedia('(prefers-color-scheme: dark)').matches);
      }
      var api = {
        get: function () { try { return localStorage.getItem('vet-theme') || 'light'; } catch (e) { return 'light'; } },
        apply: function (mode) {
          var dark = isDark(mode || api.get());
          document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
          var mc = document.querySelector('meta[name="theme-color"]');
          if (mc) mc.setAttribute('content', dark ? '#171e28' : '#ffffff');
        },
        set: function (mode) { try { localStorage.setItem('vet-theme', mode); } catch (e) {} api.apply(mode); }
      };
      api.apply();
      if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
          if (api.get() === 'auto') api.apply('auto');
        });
      }
      return api;
    })();
