/* Details for the browsing-only inventory snapshot. No payment requests here. */
(function () {
  'use strict';
  var ASP = window.ASP;
  var dialog = document.querySelector('[data-product-dialog]');
  if (!ASP || !ASP.stockSnapshot || !dialog) return;
  var select = dialog.querySelector('[data-product-options]');
  var price = dialog.querySelector('[data-product-price]');
  var optionDetails = dialog.querySelector('[data-product-option-details]');
  var currentProduct;
  var opener;
  var date = new Date(ASP.stockSnapshot.date + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  });

  ASP.stockPrice = function (product) {
    if (product.price == null) return 'Ask in store';
    var minimum = ASP.money(product.price);
    if (product.hasVariablePrice) return 'From ' + minimum;
    return product.priceMax !== product.price ? minimum + ' – ' + ASP.money(product.priceMax) : minimum;
  };

  function showVariation() {
    var variant = currentProduct.variants[select.selectedIndex];
    price.textContent = variant.price == null ? 'Ask in store' : ASP.money(variant.price) + ' USD';
    optionDetails.replaceChildren();
    variant.options.forEach(function (option) {
      var term = document.createElement('dt');
      var value = document.createElement('dd');
      term.textContent = option.name || 'Option';
      value.textContent = option.value;
      optionDetails.append(term, value);
    });
  }

  ASP.openStockProduct = function (product, trigger) {
    currentProduct = product;
    opener = trigger;
    dialog.querySelector('[data-product-title]').textContent = product.name;
    var description = dialog.querySelector('[data-product-description]');
    description.textContent = product.description;
    description.hidden = !product.description;
    dialog.querySelector('[data-product-availability]').textContent = 'Listed in stock on ' + date + '. Call to confirm availability before visiting.';
    var photo = dialog.querySelector('[data-product-image]');
    photo.hidden = !product.image;
    dialog.querySelector('[data-product-placeholder]').hidden = !!product.image;
    if (product.image) { photo.src = product.image; photo.alt = product.alt || product.name; }
    else { photo.removeAttribute('src'); photo.alt = ''; }
    select.replaceChildren();
    product.variants.forEach(function (variant, index) {
      var option = document.createElement('option');
      option.value = String(index);
      option.textContent = variant.name + ' — ' + (variant.price == null ? 'Ask in store' : ASP.money(variant.price));
      select.appendChild(option);
    });
    showVariation();
    dialog.showModal();
    document.body.classList.add('stock-dialog-open');
  };
  select.addEventListener('change', showVariation);
  dialog.querySelector('[data-product-close]').addEventListener('click', function () { dialog.close(); });
  dialog.addEventListener('click', function (event) {
    if (event.target !== dialog) return;
    var bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  dialog.addEventListener('close', function () {
    document.body.classList.remove('stock-dialog-open');
    if (opener && opener.isConnected) opener.focus({ preventScroll: true });
  });
})();
