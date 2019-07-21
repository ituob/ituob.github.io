(function () {

  // Quick and dirty expandable message widget,
  // supported by FontAwesome and some CSS (see .with-js class)
  window.initExpandable = function (card, expandableContents, iconNormal) {
    card.classList.add('with-js');

    var toggle = document.createElement('div');
    toggle.classList.add('toggle');
    toggle.setAttribute('title', "Expand or collapse message contents");

    var indicator = document.createElement('i');
    indicator.classList.add('fas', iconNormal, 'indicator');
    toggle.appendChild(indicator);

    toggle.addEventListener('click', function (evt) {
      var expanded = card.classList.toggle('expanded');
    });

    card.insertBefore(toggle, expandableContents);

    expandableContents.removeAttribute('style');
  }

  var messageCards = document.querySelectorAll('article.message');
  for (let card of messageCards) {
    var expandableContents = card.querySelector('.included-contents');
    if (expandableContents) {
      window.initExpandable(card, expandableContents, 'fa-chevron-circle-down');
    }
  }

}());
