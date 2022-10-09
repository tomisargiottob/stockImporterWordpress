const WooCommerceRestApi = require('@woocommerce/woocommerce-rest-api').default;
const errors = require('common-errors')
const xml2js = require('xml2js');
const config = require('config');
const logger = require('pino')()

const stockUrl = config.stockApi;

const WooCommerce = new WooCommerceRestApi({
  url: config.url,
  consumerKey: config.apiKey,
  consumerSecret: config.apiSecret,
  wpAPI: true,
  version: 'wc/v3'
});

async function updateStock() {
	const log = logger.child({ method: 'updateStock' });
	log.info('Searching for products in stock API');
	const rawStockData= await fetch(stockUrl);
	const stockData = await rawStockData.text();
	const parsedData = await xml2js.parseStringPromise(stockData, {explicitArray : false});
	if (!parsedData.vdato.productosweb) {
		log.error('Error searching products from stock API');
		throw new errors.ValidationError('Response changed format');
	}
	const schoolProducts = parsedData.vdato.productosweb;
	const products = schoolProducts.filter((product) => product.FAMILIA === config.school);
	log.info(`Products from ${config.school} have been filtered`);
	const skuProducts = products.reduce((updateProducts,product) => {
		updateProducts[product['ARTICULO__ID']]=product;
		return updateProducts
	},{});
	log.info('Searching products in woocommerce API');

	const { data: storeProducts } = await WooCommerce.get(`products?sku=[${Object.keys(skuProducts)}]`);
	
	const batchVariationUpdate = {};
	const batchUpdate = [];
	log.info('Dividing products between variations and unique products');
	for (const product of storeProducts) {
		if(product.parent_id) {
			if(batchVariationUpdate[product.parent_id]) {
				batchVariationUpdate[product.parent_id].push({
					id: product.id,
					regular_price: skuProducts[product.sku].PRECIOVENTA,
					manage_stock: true,
					stock_quantity:  skuProducts[product.sku].STOCK,
				})
			} else {
				batchVariationUpdate[product.parent_id] = [{
					id: product.id,
					regular_price: skuProducts[product.sku].PRECIOVENTA,
					manage_stock: true,
					stock_quantity:  skuProducts[product.sku].STOCK,
				}]
			}
		} else {
			batchUpdate.push({
				id: product.id,
				regular_price: skuProducts[product.sku].PRECIOVENTA,
				manage_stock: true,
				stock_quantity:  skuProducts[product.sku].STOCK,
			})
		}
	}
	log.info('Updating unique products');

	const updatedProducts = await WooCommerce.post('products/batch',{update: batchUpdate});
	
	log.info('Updating variation products');

	const updatePromises = Object.keys(batchVariationUpdate).map(async (parent) => {
		try {
			await WooCommerce.post(`products/${parent}/variations/batch`,{update: batchVariationUpdate[parent]})
			return parent;
		} catch (err) {
			return false;
		}
	})

	const updatedVariations = await Promise.all(updatePromises);

	setTimeout(updateStock, config.shcedule)
}

updateStock();