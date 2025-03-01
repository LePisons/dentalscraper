# E-commerce Dental Product Scraper

## Overview

This project is a specialized web scraper designed to extract product information from multiple dental supply e-commerce websites. It uses a sitemap-based approach to discover product URLs and then extracts detailed product information including names, prices, stock status, descriptions, and specifications.

## Features

- **Multi-site Support**: Currently scrapes products from:

  - Ortotek (WooCommerce)
  - Denteeth (WooCommerce)
  - GAC Chile (WooCommerce)
  - Damus (JumpSeller)

- **Intelligent Product Detection**: Uses multiple indicators to verify if a page is actually a product page before attempting to extract data.

- **Robust Price Extraction**: Handles various price formats and structures, including special cases for different platforms.

- **Stock Status Detection**: Accurately identifies product availability, including out-of-stock products.

- **Comprehensive Data Extraction**: Captures product names, prices, stock status, images, descriptions, specifications, and more.

- **Error Handling**: Includes retry mechanisms and graceful error handling to maximize successful data extraction.

- **Test Mode**: Supports a configurable test mode to limit the number of products scraped during development and testing.

## How It Works

1. **Sitemap Processing**: The scraper first retrieves and processes XML sitemaps from each target website to discover product URLs.

2. **URL Filtering**: Non-product URLs are filtered out based on URL patterns and structures.

3. **Concurrent Scraping**: Products are scraped concurrently with configurable limits to balance speed and server load.

4. **Data Extraction**: For each product page, the scraper:

   - Verifies it's a product page
   - Extracts product details using platform-specific selectors
   - Handles special cases for different site structures
   - Processes stock information and price data

5. **Data Storage**: Results are saved as JSON files, organized by site and with timestamps.

## Technical Implementation

- **Playwright**: Used for browser automation and page interaction
- **Axios**: Handles HTTP requests for sitemap retrieval
- **XML2JS**: Parses XML sitemaps
- **Node.js**: Runtime environment

## Configuration

The scraper's behavior can be adjusted through the `CONFIG` object:

- `concurrentBrowsers`: Number of concurrent browser instances
- `requestDelay`: Delay between requests to the same site
- `timeout`: Page load timeout
- `maxRetries`: Maximum retry attempts for failed scrapes
- `testMode`: Enable/disable test mode
- `testProductLimit`: Number of products to scrape per site in test mode
- `outputDir`: Directory for saving results

## Usage

1. Ensure Node.js is installed on your system
2. Install dependencies:
   ```
   npm install
   ```
3. Run the scraper:
   ```
   node scrapper.js
   ```

## Output

The scraper generates JSON files in the `scraper_results` directory:

- One combined file with all products
- Individual files for each site's products

Each product record includes:

- Name
- Price
- Stock status
- Link to product page
- Image URL
- Description
- Specifications (when available)
- Timestamp

## Notes

This project is for personal use and not currently open for collaboration. It's designed for specific dental supply websites and may require adjustments for other e-commerce platforms.
