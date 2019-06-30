(function () {

  // Quick and dirty expandable message widget,
  // supported by FontAwesome and some CSS (see .with-js class)

  var messageCards = document.querySelectorAll('article.message');
  for (let card of messageCards) {
    if (card.querySelector('.included-contents')) {
      card.classList.add('with-js');

      var chevron = document.createElement('i');
      chevron.classList.add('fas', 'fa-chevron-circle-right');
      chevron.addEventListener('click', function (evt) {
        var expanded = card.classList.toggle('expanded');
        if (expanded) {
          evt.target.classList.remove('fa-chevron-circle-right');
          evt.target.classList.add('fa-chevron-circle-down');
        } else {
          evt.target.classList.remove('fa-chevron-circle-down');
          evt.target.classList.add('fa-chevron-circle-right');
        }
      });

      card.querySelector('header .title').prepend(chevron);
    }
  }
}());
