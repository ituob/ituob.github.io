(function () {

  // Quick and dirty expandable message widget,
  // supported by FontAwesome and some CSS (see .with-js class)

  var messageCards = document.querySelectorAll('article.message');
  for (let card of messageCards) {
    var expandableContents = card.querySelector('.included-contents');
    if (expandableContents) {
      var header = Array.from(card.children).filter(e => e.matches('header'))[0];

      if (header === undefined) { continue; }

      card.classList.add('with-js');

      var title = header.querySelector('.title');
      var label = title.querySelector('.label');

      var toggle = document.createElement('div');
      toggle.classList.add('toggle');
      toggle.setAttribute('title', "Expand or collapse message contents");

      var indicator = document.createElement('i');
      indicator.classList.add('fas', 'fa-chevron-circle-down', 'indicator');
      toggle.appendChild(indicator);

      toggle.addEventListener('click', function (evt) {
        var expanded = card.classList.toggle('expanded');
      });

      card.insertBefore(toggle, expandableContents);

      expandableContents.removeAttribute('style');
    }
  }
}());
