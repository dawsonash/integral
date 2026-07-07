// Tiny client-side "backend": cart lives in sessionStorage (seed-data friendly).
(function () {
  function cart() {
    try { return JSON.parse(sessionStorage.getItem('cart') || '[]'); } catch (e) { return []; }
  }
  function save(c) { sessionStorage.setItem('cart', JSON.stringify(c)); }

  var count = document.getElementById('cart-count');
  if (count) count.textContent = cart().length;

  document.querySelectorAll('button.add').forEach(function (b) {
    b.addEventListener('click', function () {
      var c = cart();
      c.push(b.dataset.item);
      save(c);
      if (count) count.textContent = c.length;
      b.textContent = 'Added ✓';
      setTimeout(function () { b.textContent = 'Add to cart'; }, 900);
    });
  });

  var list = document.getElementById('cart-items');
  if (list) {
    var c = cart();
    if (c.length) {
      list.innerHTML = '';
      c.forEach(function (item) {
        var li = document.createElement('li');
        li.textContent = item + ' hoodie';
        list.appendChild(li);
      });
    }
  }

  var checkout = document.getElementById('checkout');
  if (checkout) {
    checkout.addEventListener('click', function () {
      sessionStorage.removeItem('cart');
      location.href = 'done.html';
    });
  }
})();
