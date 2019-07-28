/* Vocabulary:
 * Section: e.g. General or Amendments; a group of messages.
 * Message: message as it is.
 */

(function () {

  window.stickyNav = initStickyIssueNavigation();

  function initStickyIssueNavigation() {
    let sectionMenu = makeMenu();
    sectionMenu.setItems(buildSectionMenu());
    sectionMenu.wrapper.classList.add('section-menu');

    let messageMenu = makeMenu();
    messageMenu.setItems([]);
    messageMenu.wrapper.classList.add('message-menu');

    var issueLabel = document.createElement('div');
    issueLabel.classList.add('issue-id');
    issueLabel.textContent = document.querySelector('main > header .seq-no').textContent;

    var menuBar = document.createElement('nav');
    menuBar.classList.add('with-js');
    menuBar.classList.add('fixable-bar');
    menuBar.appendChild(issueLabel);
    menuBar.appendChild(sectionMenu.wrapper);
    menuBar.appendChild(messageMenu.wrapper);

    makeMessageAnchorMenuAware(sectionMenu, messageMenu);

    document.querySelector('body > main').
      insertBefore(menuBar, sectionMenu.getItems()[0].el);

    function handleMessageVisibilityChange(entries) {
      // Most of the time IntersectionObserver reports current entry correctly;
      // however, in some scrolling situations it fires but the currently intersecting item
      // on the top is not among the entries, so we have to fall back manual check.
      const currentMessageEl = getTopIntersectingEntry(entries) || goFigureCurrentMessage(sectionMenu.getItems());

      if (currentMessageEl) {
        selectMessageAndSection(currentMessageEl, sectionMenu, messageMenu);
      }
    }

    const messageObserver = new IntersectionObserver((entries, observer) => { 
      handleMessageVisibilityChange(entries);
    }, {
      rootMargin: '-10% 0px -88% 0px',
    });

    observeMessages(messageObserver, sectionMenu.getItems());

    window.addEventListener('scroll', function () {
      const tocRect = sectionMenu.getItems()[0].el.getBoundingClientRect();
      if (tocRect.top < 0) {
        menuBar.classList.add('fixed');
      } else {
        menuBar.classList.remove('fixed');
      }
    });

    return {
      menuBar: menuBar,
    };

  }

  // Updates browser location bar (adds a history record)
  // and highlights the card corresponding to the menu item
  // (un-highlighting other items’ cards).
  function registerActiveMessage(item, otherItems) {
    history.pushState(null, null, '#' + item.id);
    otherItems.map(i => { i.el.classList.remove('active'); });
    item.el.classList.add('active');
  }


  // Makes it so that anchors don’t use default behavior
  // but instead select message using menu’s mechanism.
  function makeMessageAnchorMenuAware(sectionMenu, messageMenu) {
    for (let section of sectionMenu.getItems()) {
      for (let message of section.items) {
        const anchor = message.el.querySelector('a.anchor');
        if (anchor) {
          anchor.addEventListener('click', function (evt) {
            message.anchor.scrollIntoView({ behavior: 'smooth' });
            selectMessageAndSection(message.el, sectionMenu, messageMenu);
            registerActiveMessage(message, messageMenu.getItems());
            evt.preventDefault();
          });
        }
      }
    }
  }


  /* Creates an object encapsulating menu-related behaviors (coupled to DOM). */

  function makeMenu() {
    var items = [];
    var selectedItem = null;

    var wrapper = document.createElement('div');
    wrapper.classList.add('menu-wrapper');

    var trigger = document.createElement('div');
    trigger.classList.add('trigger');
    wrapper.appendChild(trigger);

    var icon = document.createElement('i');
    icon.classList.add('fas');
    icon.classList.add('fa-list-ul');
    trigger.appendChild(icon);

    var triggerText = document.createElement('span');
    triggerText.classList.add('text');
    trigger.appendChild(triggerText);

    var ul = document.createElement('ul');
    wrapper.appendChild(ul);

    // Public methods

    function setItems(newItems) {
      if (newItems.length > 0) {
        items = newItems;

        while (ul.hasChildNodes()) {
          ul.removeChild(ul.firstChild);
        }
        for (let item of items) {
          var li = document.createElement('li');
          li.textContent = item.title;
          li.setAttribute('data-item-id', item.id);
          li.addEventListener('click', function() {
            (item.anchor || item.el).scrollIntoView({ behavior: 'smooth' });

            // Patiently wait until scrolling is completed, then select the item.
            // Otherwise behavior is incorrect if selected item is at the bottom
            // of the viewport (end of message list): scrolling will select
            // a higher-positioned item by design.
            var scrollTimeout = setTimeout(function () {
              _selectItem(item);
              registerActiveMessage(item, items);
            }, 50);
            function selectAfterScrollEnds() {
              clearTimeout(scrollTimeout);
              scrollTimeout = setTimeout(function () {
                _selectItem(item);
                registerActiveMessage(item, items);
                window.removeEventListener('scroll', selectAfterScrollEnds);
              }, 50);
            }
            window.addEventListener('scroll', selectAfterScrollEnds);
          });
          ul.appendChild(li);
        }
      }
      _selectItem(null);
    }

    function selectItemByTitle(title) {
      for (let item of items) {
        if (item.title === title) {
          _selectItem(item);
          break;
        }
      }
    }

    function selectItemContainingSubitemWithTitle(title) {
      for (let item of items) {
        for (let subitem of item.items) {
          if (subitem.title === title) {
            _selectItem(item);
            break;
          }
        }
      }
    }

    // Private

    function _selectItem(item) {
      selectedItem = item;

      if (item) {
        Array.from(ul.children).
          forEach(el => el.classList.remove('selected'));

        triggerText.textContent = item.title;

        const selectedItemMenuListItemEl = Array.from(ul.children).
          filter(el => el.matches('[data-item-id=' + item.id + ']'))[0];
        if (selectedItemMenuListItemEl) {
          selectedItemMenuListItemEl.classList.add('selected');
        }
      }
    }

    trigger.addEventListener('click', (evt) => {
      wrapper.classList.toggle('expanded');
    });


    return {

      getItems: function () { return items; },
      getSelectedItem: function () { return selectedItem; },

      setItems: setItems,
      selectItemByTitle: selectItemByTitle,
      selectItemContainingSubitemWithTitle: selectItemContainingSubitemWithTitle,

      wrapper: wrapper,

    }
  }

  function selectMessageAndSection(currentMessageEl, sectionMenu, messageMenu) {
    const messageTitle = getMenuItemTitleForMessage(currentMessageEl);
    sectionMenu.selectItemContainingSubitemWithTitle(messageTitle);
    messageMenu.setItems(sectionMenu.getSelectedItem().items);
    messageMenu.selectItemByTitle(messageTitle);
  }


  /* Utility functions */

  // Given IntersectionObserver instance, and an iterable of section menu items,
  // starts observing the DOM element corresponding to each message in each section.
  function observeMessages(iObserver, sectionMenuItems) {
    function _observe() {
      for (let item of sectionMenuItems) {
        for (let message of item.items) {
          iObserver.observe(message.el);
        }
      }
    }
    _observe();
  }

  // Iterating over sections & messages, determines
  // which message is currently current (the user is scrolling through it).
  function goFigureCurrentMessage(sections) {
    console.debug('figuring out current message');
    for (let section of sections) {
      for (let message of section.items) {
        const rect = message.el.getBoundingClientRect();
        if (rect.top < 100 && rect.bottom > 0) {
          return message.el;
        }
      }
    }

    return null;
  }

  // Given a list of Intersection Observer entries, returns DOM element
  // of the entry that is the first visible from the top of the viewport.
  function getTopIntersectingEntry(entries) {
    const intersectingEntries = entries.filter(e => e.isIntersecting);

    if (intersectingEntries.length > 0) {
      const topItem = intersectingEntries.reduce((previous, current) => {
        return (previous.boundingClientRect.top < current.boundingClientRect.top) ? previous : current;
      });
      return topItem.target;
    }

    return null;
  }

  function getMenuItemTitleForSection(element) {
    return Array.from(element.children).
      filter(e => e.matches('h3'))[0].textContent;
  }

  function getMenuItemTitleForMessage(element) {
    return Array.from(element.children).
      filter(e => e.matches('header'))[0].querySelector('.title > .text').textContent;
  }

  function buildSectionMenu() {
    var items = [];
    for (let sectionEl of document.querySelectorAll('main > section')) {
      if (sectionEl.hasAttribute('id')) {  // Exclude items without anchor
        items.push({
          title: getMenuItemTitleForSection(sectionEl),
          id: sectionEl.getAttribute('id'),
          el: sectionEl,
          items: buildMessageMenuForSection(sectionEl),
        });
      }
    }
    return items;
  }

  function buildMessageMenuForSection(element) {
    var items = [];
    Array.from(element.children).
        filter(e => e.matches('article')).
        forEach(messageEl => {
      const anchor = messageEl.querySelector('a.anchor');
      if (anchor && anchor.hasAttribute('id')) {  // Exclude items without anchor
        items.push({
          title: getMenuItemTitleForMessage(messageEl),
          id: anchor.getAttribute('id'),
          anchor: anchor,
          el: messageEl,
        });
      }
    });
    return items;
  }

}());
