const WooCommerceRestApi = require('@woocommerce/woocommerce-rest-api').default;
const errors = require('common-errors')
const xml2js = require('xml2js');
const config = require('config');
const logger = require('pino')()
const fs = require('fs/promises');

const stockUrl = config.stockApi;

const WooCommerce = new WooCommerceRestApi({
  url: config.url,
  consumerKey: config.apiKey,
  consumerSecret: config.apiSecret,
  wpAPI: true,
  version: 'wc/v3'
});

const skuRegex = /(\w+)-*(\w+)*/

async function updateStock() {
	const log = logger.child({ method: 'updateStock' });
	log.info('Searching for products in stock API');
	const rawStockData= await fetch(config.stockUrl);
	const stockData = await rawStockData.text();
	const parsedData = await xml2js.parseStringPromise(stockData, {explicitArray : false});
	if (!parsedData.vdato.productosweb) {
		log.error('Error searching products from stock API');
		throw new errors.ValidationError('Response changed format');
	}
	const schoolProducts = parsedData.vdato.productosweb;
	const products = schoolProducts.filter((product) => product.FAMILIA === config.school);
	log.info(`Products from ${config.school} have been filtered`);
	const memory = await fs.readFile('./storeProducts.json');
	const memoryProducts = JSON.parse(memory.toString())
	log.info('Searching products in woocommerce API');

	const { missingProducts, productVariation, updatableItems } = products.reduce((uniqueProducts, product) => {
		const productDescomposition = product['ARTICULO__ID'].match(skuRegex);
		if(!memoryProducts[productDescomposition[1]]) {
			uniqueProducts.missingProducts.add(productDescomposition[1])
		}
		if(productDescomposition[2]) {
			if (!memoryProducts[product['ARTICULO__ID']]) {
				if(!uniqueProducts.productVariation[productDescomposition[1]]){
					uniqueProducts.productVariation[productDescomposition[1]] = [];
				}
				uniqueProducts.productVariation[productDescomposition[1]].push(product['ARTICULO__ID'])
			}
		}
		uniqueProducts.updatableItems[product['ARTICULO__ID']] = product;
		return uniqueProducts
	}, { missingProducts: new Set(), updatableItems: {}, productVariation: {}})
	const { data: storeProducts } = await WooCommerce.get(`products?sku=${Array.from(missingProducts).join(',')}`,{per_page:100});
	for (const product of storeProducts) {
		if (product.sku) {
			memoryProducts[product.sku] = product.id;
			const { data: variations } = await WooCommerce.get(`products/${product.id}/variations?sku=${productVariation[product.sku].join(',')}`,{per_page:100});
			variations.forEach((variation) => {
				memoryProducts[variation.sku] = variation.id;
			})
		}
	}
	const batchVariationUpdate = {};
	const batchUpdate = [];
	log.info('Dividing products between variations and unique products');
	for (const product of Object.keys(updatableItems)) {
		if (memoryProducts[product]) {
			const productDescomposition = product.match(skuRegex);
			if(productDescomposition[2]) {
				if(!batchVariationUpdate[productDescomposition[1]]) {
					batchVariationUpdate[productDescomposition[1]] = []
				}
				batchVariationUpdate[productDescomposition[1]].push({
					id: memoryProducts[product],
					regular_price: +updatableItems[product].PRECIOVENTA,
					manage_stock: true,
					stock_quantity:  updatableItems[product].STOCK,
				})
			} else {
				batchUpdate.push({
					id: memoryProducts[product],
					regular_price: +updatableItems[product].PRECIOVENTA,
					manage_stock: true,
					stock_quantity:  updatableItems[product].STOCK,
				})
			}	
		} else {
			logger.error(`Could not update ${product} as it was not found in woocommerce store`)
		}
	}
	log.info('Updating unique products');

	const updatedProducts = await WooCommerce.post('products/batch',{update: batchUpdate});
	
	log.info('Updating variation products');

	const updatePromises = Object.keys(batchVariationUpdate).map(async (parent) => {
		try {
			await WooCommerce.post(`products/${memoryProducts[parent]}/variations/batch`,{update: batchVariationUpdate[parent]})
			return parent;
		} catch (err) {
			log.error(`Could not update ${parent} and all its variations`)
			return false;
		}
	})

	const updatedVariations = await Promise.all(updatePromises);
	logger.info('Successfully updated products');
	await fs.writeFile('./storeProducts.json',JSON.stringify(memoryProducts));
	setTimeout(updateStock, config.shcedule)
}

updateStock();