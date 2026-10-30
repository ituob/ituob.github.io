/**
 * Row filter for static bulletin tables. Each filterable block is
 * structured as:
 *
 *   <div class="regtable">
 *     <div class="regtable-tools">
 *       <input type="search" class="regtable-find" ...>
 *       <span class="regtable-count" ...>N rows</span>
 *     </div>
 *     <table>…</table>
 *   </div>
 *
 * Rows whose text does not match the query are hidden. A row spanned
 * into a single cell (a section or placeholder row) only shows while
 * the query is empty. The count reports matches while filtering.
 */
(function () {
  var blocks = document.querySelectorAll(".regtable");
  for (var b = 0; b < blocks.length; b++) {
    (function (block) {
      var input = block.querySelector(".regtable-find");
      var count = block.querySelector(".regtable-count");
      var table = block.querySelector("table");
      if (!input || !table || input.dataset.filterWired) return;
      input.dataset.filterWired = "1";
      var body = table.tBodies[0];

      function isSection(row) {
        return row.cells.length === 1;
      }

      function apply() {
        var q = input.value.trim().toLowerCase();
        var shown = 0;
        for (var i = 0; i < body.rows.length; i++) {
          var row = body.rows[i];
          var hit = !q || row.textContent.toLowerCase().indexOf(q) !== -1;
          row.style.display = hit && !(q && isSection(row)) ? "" : "none";
          if (hit && !isSection(row)) shown++;
        }
        if (count) {
          count.textContent = q ? shown + " of " + total + " rows" : total + " rows";
        }
      }

      var total = 0;
      for (var j = 0; j < body.rows.length; j++) {
        if (!isSection(body.rows[j])) total++;
      }
      if (count) count.textContent = total + " rows";

      input.addEventListener("input", apply);
      input.addEventListener("search", apply);
    })(blocks[b]);
  }

  // "/" focuses the first filter, matching the register page's find box.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    var first = document.querySelector(".regtable-find");
    if (first) {
      e.preventDefault();
      first.focus();
    }
  });
})();
