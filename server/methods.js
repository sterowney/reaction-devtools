import faker from "faker";
import _ from "lodash";
import { slugify } from "transliteration";
import { Meteor } from "meteor/meteor";
import { Random } from "meteor/random";
import { Shops, Products, ProductSearch, Tags, Media, Packages } from "/lib/collections";
import { Logger } from "/server/api";
import { productTemplate, variantTemplate, optionTemplate } from "./dataset";
import { buildProductSearch } from "/imports/plugins/included/search-mongo/server/methods/searchcollections";


const methods = {};


methods.loadShops = function () {
  Logger.info("Starting load Shops");
  const shops = require("/imports/plugins/custom/swag-shop/private/data/Shops.json");
  shops.forEach((shop) => {
    Shops.insert(shop);
    Logger.info(`Inserted shop: ${shop.name}`);
  });
  Logger.info("Shops loaded");
};

methods.resetShops = function () {
  const shops =   require("/imports/plugins/custom/swag-shop/private/data/Shops.json");
  const shop = shops[0];
  // Let's remove any shops that are not ours
  Shops.remove({ _id: { $ne: shop._id } });
  const rawShopCollection = Shops.rawCollection();
  rawShopCollection.update({ _id: shop._id }, shop);
  Logger.info("Shop reset to original values");
};


methods.resetMedia = () => {
  Media.files.direct.remove({});
};

methods.loadSmallProducts = function () {
  Logger.info("Starting load Products");
  const products = require("/imports/plugins/custom/reaction-devtools/sample-data/data/small/Products.json");
  products.forEach((product) => {
    product.workflow.workflow = ["imported"]; // setting this bypasses revision control
    product.createdAt = new Date();
    product.updatedAt = new Date();
    Products.insert(product, {}, { publish: true });
  });
  Logger.info("Products loaded");
};

methods.loadSmallTags = function () {
  Logger.info("Starting load Tags");
  const tags = require("/imports/plugins/custom/reaction-devtools/sample-data/data/small/Tags.json");
  tags.forEach((tag) => {
    tag.updatedAt = new Date();
    Tags.insert(tag);
  });
  Logger.info("Tags loaded");
};

function getTopVariant(productId) {
  const topVariant = Products.findOne({
    "ancestors": { $in: [productId] },
    "ancestors.1": { $exists: false }
  });
  return topVariant;
}

methods.importProductImages = function () {
  Logger.info("Started loading product images");
  const products = Products.find({ type: "simple" }).fetch();
  for (const product of products) {
    const productId = product._id;
    if (!Media.findOne({ "metadata.productId": productId })) {
      const shopId = product.shopId;
      const filepath = "custom/images/" + productId + ".jpg";
      const binary = Assets.getBinary(filepath);
      const fileObj = new FS.File();
      const fileName = `${productId}.jpg`;
      fileObj.attachData(binary, { type: "image/jpeg", name: fileName });
      const topVariant = getTopVariant(productId);
      fileObj.metadata = {
        productId,
        variantId: topVariant._id,
        toGrid: 1,
        shopId,
        priority: 0,
        workflow: "published"
      };
      Media.insert(fileObj);
    }
  }
  Logger.info("loaded product images");
};

methods.addProduct = function () {
  const products = [];
  const product = _.cloneDeep(productTemplate);
  const productId = Random.id().toString();
  const variant = _.cloneDeep(variantTemplate);
  const variantId = Random.id().toString();
  product._id = productId;
  product.description = faker.lorem.paragraph();
  product.title = faker.commerce.productName();
  product.vendor = faker.company.companyName();
  product.handle = slugify(product.title);
  product.createdAt = new Date();
  product.updatedAt = new Date();
  // always one top level variant
  variant._id = variantId;
  variant.ancestors = [productId];
  variant.title = faker.commerce.productName();
  variant.createdAt = new Date();
  variant.updatedAt = new Date();
  products.push(variant);
  const numOptions = Random.choice([1, 2, 3, 4]);
  const optionPrices = [];
  for (let x = 0; x < numOptions; x++) {
    const option = _.cloneDeep(optionTemplate);
    const optionId = Random.id().toString();
    option._id = optionId;
    option.optionTitle = faker.commerce.productName();
    option.price = faker.commerce.price();
    optionPrices.push(parseFloat(option.price));
    option.ancestors = [productId, variantId];
    products.push(option);
  }
  const priceMin = _.min(optionPrices);
  const priceMax = _.max(optionPrices);
  let priceRange = `${priceMin} - ${priceMax}`;
  // if we don't have a range
  if (priceMin === priceMax) {
    priceRange = priceMin.toString();
  }
  const priceObject = {
    range: priceRange,
    min: priceMin,
    max: priceMax
  };
  product.price = priceObject;
  products.push(product);
  return products;
};

methods.resetData = function () {
  // delete existing data
  Tags.remove({});
  Products.direct.remove({});
  ProductSearch.remove({});
  methods.resetMedia();
};

methods.loadSmallDataset = function () {
  methods.resetData();
  methods.loadSmallTags();
  methods.loadSmallProducts();
};

methods.loadDataset = function (numProducts = 1000) {
  methods.resetData();
  Logger.info("Loading Medium Dataset");
  const rawProducts = Products.rawCollection();
  const products = [];
  for (let x = 0; x < numProducts; x++) {
    const newProducts = methods.addProduct();
    products.push(...newProducts);
  }
  const writeOperations = products.map((product) => {
    return { insertOne: product };
  });
  rawProducts.bulkWrite(writeOperations);
  Logger.info(`Created ${numProducts} records`);
};

methods.loadMediumTags = function () {
  const tags = require("/imports/plugins/custom/reaction-devtools/sample-data/data/medium/Tags.json");
  tags.forEach((tag) => {
    tag.updatedAt = new Date();
    Tags.insert(tag);
  });
  Logger.info("Tags loaded");
  return tags;
};

methods.turnOffRevisions = function () {
  Packages.update({
    name: "reaction-revisions"
  }, {
    $set: {
      "settings.general.enabled": false
    }
  });
};

methods.turnOnRevisions = function () {
  Packages.update({
    name: "reaction-revisions"
  }, {
    $set: {
      "settings.general.enabled": true
    }
  });
};

methods.assignHashtagsToProducts = function (tags, productPerCategory = 100) {
  const products = Products.find({ type: "simple" },  { _id: 1 }).fetch();
  const tagIds = tags.reduce((tagArray, tag) => {
    if (!tag.isTopLevel) {
      tagArray.push(tag._id);
    }
    return tagArray;
  }, []);
  const rawProducts = Products.rawCollection();
  const writeOperations = [];
  tagIds.map((tagId) => {
    for (let x = 0; x < productPerCategory; x++) {
      const product = Random.choice(products);
      const filter = { _id: product._id };
      const update = { $addToSet: { hashtags: tagId } };
      writeOperations.push({ updateOne: { filter, update } });
    }
  });
  rawProducts.bulkWrite(writeOperations);
  Logger.info("Tags assigned");
};

methods.loadMediumDataset = function () {
  methods.turnOffRevisions();
  methods.resetData();
  methods.loadDataset(1000);
  const tags = methods.loadMediumTags();
  methods.assignHashtagsToProducts(tags);
  // try to use this to make reactivity work
  // Products.update({}, { $set: { visible: true } }, { multi: true }, { selector: { type: "simple" }, publish: true });
  methods.turnOnRevisions();
  buildProductSearch();
};

methods.loadLargeDataset = function () {
  methods.resetData();
  methods.loadDataset(10000);
};

export default methods;

Meteor.methods({
  "devtools/loaddata/small": methods.loadSmallDataset,
  "devtools/loaddata/medium": methods.loadMediumDataset,
  "devtools/loaddata/large": methods.loadLargeDataset,
  "devtools/resetData": methods.resetData
});
