(function () {

  // Quick and dirty expandable message widget,
  // supported by FontAwesome and some CSS (see .with-js class)
  window.initExpandable = function (card, expandableContents, iconNormal, onChangeState) {

    var expanded = false;

    function expand() {
      expanded = true;
      card.classList.add('expanded');
      if (onChangeState) { onChangeState(expanded) };
    }

    function collapse() {
      expanded = false;
      card.classList.remove('expanded');
      if (onChangeState) { onChangeState(expanded) };
    }

    function toggleState() {
      expanded = card.classList.toggle('expanded');
      if (onChangeState) { onChangeState(expanded) };
    }

    var toggle = document.createElement('div');
    toggle.classList.add('toggle');
    toggle.setAttribute('title', "Expand or collapse message contents");

    var indicator = document.createElement('i');
    indicator.classList.add('fas', iconNormal, 'indicator');
    toggle.appendChild(indicator);

    toggle.addEventListener('click', toggleState);

    card.insertBefore(toggle, expandableContents);
    card.classList.add('with-js');
    expandableContents.removeAttribute('style');

    return {
      isExpanded: function () { return expanded; },
      expand: expand,
      collapse: collapse,
    };
  };

  function makeGlobalToggle(expandables, iconNormal) {
    var globallyExpanded = false;

    function updateGloballyExpanded(newState) {
      globallyExpanded = newState;

      if (newState === true) {
        toggle.classList.remove('undefined');
        toggle.classList.add('expanded');
        label.textContent = "Collapse all mesages";
      } else if (newState === false) {
        toggle.classList.remove('undefined');
        toggle.classList.remove('expanded');
        label.textContent = "Expand all mesages";
      } else {
        toggle.classList.remove('expanded');
        toggle.classList.add('undefined');
        label.textContent = "Expand all mesages";
      }
    }

    function expandAll() {
      expandables.forEach(expandable => expandable.expand());
      updateGloballyExpanded(true);
    }

    function collapseAll() {
      expandables.forEach(expandable => expandable.collapse());
      updateGloballyExpanded(false);
    }

    var toggle = document.createElement('p');
    toggle.classList.add('global-expand-toggle');
    toggle.setAttribute('title', "Expand or collapse all messages");

    var indicator = document.createElement('i');
    indicator.classList.add('fas', iconNormal, 'indicator');
    toggle.appendChild(indicator);

    toggle.appendChild(document.createTextNode(' '));

    var label = document.createElement('span');
    label.textContent = "Expand all messages";
    toggle.appendChild(label);

    toggle.addEventListener('click', function () {
      if (globallyExpanded) {
        collapseAll();
      } else {
        expandAll();
      }
    });

    return {
      el: toggle,
      updateState: updateGloballyExpanded,
    };
  }

  function makeAllMessagesExpandable () {
    function handleStateChange(expandable) {
      if (expandables.every(exp => exp.isExpanded() === true)) {
        globalToggle.updateState(true);
      } else if (expandables.every(exp => exp.isExpanded() === false)) {
        globalToggle.updateState(false);
      } else {
        globalToggle.updateState(undefined);
      }
    }

    var messageCards = document.querySelectorAll('article.message');
    var expandables = [];
    for (let card of messageCards) {
      var expandableContents = card.querySelector('.included-contents');
      if (expandableContents) {
        expandables.push(window.initExpandable(
          card, expandableContents, 'fa-chevron-circle-down', handleStateChange));
      }
    }

    var globalToggle = makeGlobalToggle(expandables, 'fa-chevron-circle-right');

    return {
      globalToggle: globalToggle,
    };
  };

  var tocEl = document.querySelector('nav.toc');
  var expandableMessageController = makeAllMessagesExpandable();
  if (tocEl) {
    tocEl.appendChild(expandableMessageController.globalToggle.el);
  }

}());
