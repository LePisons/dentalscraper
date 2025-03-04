import runScraper from "./scraper.js";
import dotenv from "dotenv";

dotenv.config();

const SCRAPING_INTERVAL = parseInt(process.env.SCRAPING_INTERVAL) || 21600; // 6 hours in seconds

async function startScheduler() {
  console.log("🕒 Starting scraper scheduler");
  console.log(
    `📅 Scraping interval set to ${SCRAPING_INTERVAL} seconds (${
      SCRAPING_INTERVAL / 3600
    } hours)`
  );

  // Run immediately on start
  try {
    console.log("🚀 Running initial scrape...");
    await runScraper();
  } catch (error) {
    console.error("❌ Error in initial scrape:", error);
  }

  // Schedule regular runs
  setInterval(async () => {
    try {
      console.log("🔄 Running scheduled scrape...");
      await runScraper();
    } catch (error) {
      console.error("❌ Error in scheduled scrape:", error);
    }
  }, SCRAPING_INTERVAL * 1000);
}

// Start the scheduler
startScheduler().catch((error) => {
  console.error("❌ Fatal error in scheduler:", error);
  process.exit(1);
});
