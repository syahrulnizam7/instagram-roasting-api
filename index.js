const cors = require("cors");
const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const rateLimit = require("express-rate-limit");
const puppeteer = require("puppeteer");
require("dotenv").config();
const {
  GoogleGenerativeAI,
  GoogleGenerativeAIResponseError,
  HarmCategory,
  HarmBlockThreshold,
  GoogleGenerativeAIError,
} = require("@google/generative-ai");

async function scrapeInstagramProfile(username) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.goto(`https://www.instagram.com/${username}/`, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    // Check if profile exists
    const notFoundSelector = 'div[data-testid="empty-user-container"]';
    const notFound = await page.$(notFoundSelector).catch(() => null);

    if (notFound) {
      await browser.close();
      return { status: 404, data: null };
    }

    // Log HTML untuk debugging
    const html = await page.content();
    console.log(html); // Cetak HTML ke terminal

    // Extract profile data
    const profileData = await page.evaluate(() => {
      // Basic profile info from meta tags
      const name =
        document
          .querySelector('meta[property="og:title"]')
          ?.content?.split(" (@")[0] || "";

      // Ambil bio dari elemen span
      const bioElement = document.querySelector(
        "div.x7a106z span._ap3a._aaco._aacu._aacx._aad7._aade"
      );
      const bio = bioElement?.textContent?.trim() || "";

      // Ambil followers, following, dan posts dari meta tag description
      const followers =
        document
          .querySelector('meta[name="description"]')
          ?.content?.match(/(\d+) Followers/)?.[1] || "0";
      const following =
        document
          .querySelector('meta[name="description"]')
          ?.content?.match(/(\d+) Following/)?.[1] || "0";
      const posts =
        document
          .querySelector('meta[name="description"]')
          ?.content?.match(/(\d+) Posts/)?.[1] || "0";

      // Get post thumbnails
      const postElements = Array.from(document.querySelectorAll("article img"));
      const postImages = postElements.slice(0, 10).map((img) => img.src);

      // Check if account is private
      const isPrivate = document.body.textContent.includes(
        "This Account is Private"
      );

      return {
        username:
          document
            .querySelector('meta[property="og:url"]')
            ?.content?.split("instagram.com/")[1]
            ?.replace(/\//g, "") || "",
        name,
        bio, // Hanya teks bio tanpa informasi followers, following, dan posts
        followers,
        following,
        posts,
        isPrivate,
        postImages,
        lastActivity: new Date().toISOString(),
      };
    });

    // Log data scraping ke terminal
    console.log("Scraped Data:", profileData);

    await browser.close();
    return { status: 200, data: profileData };
  } catch (error) {
    console.error("Error scraping Instagram profile:", error);
    await browser.close();
    return { status: 500, data: null, error: error.message };
  }
}

async function generateContent(model, prompt, aiService) {
  const safetySettings = [
    {
      category: HarmCategory.HARM_CATEGORY_HARASSMENT,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
    {
      category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
      threshold: HarmBlockThreshold.BLOCK_NONE,
    },
  ];

  const modelAi = aiService.getGenerativeModel({
    model: "gemini-1.5-flash",
    safetySettings,
  });
  const result = await modelAi.generateContent(prompt);
  const response = await result.response;
  return response.text();
}

const app = express();

// CORS configuration
var allowlist = [
  "localhost:3000",
  "instagram-roaster.vercel.app",
  "instagram-roaster.netlify.app",
];
var corsOptionsDelegate = function (req, callback) {
  var corsOptions;
  if (
    allowlist.indexOf(req.header("Origin")) !== -1 ||
    process.env.NODE_ENV === "development"
  ) {
    corsOptions = { origin: true };
  } else {
    corsOptions = { origin: false };
  }
  callback(null, corsOptions);
};
app.use(cors(corsOptionsDelegate));

// Rate limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  limit: 30, // Limit each IP to 30 requests per window
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

app.use(limiter);
app.use(bodyParser.json());

app.post("/roast", async (req, res) => {
  // Block curl/script requests
  if (
    req.headers["user-agent"] != null &&
    (req.headers["user-agent"].includes("curl") ||
      req.headers["user-agent"].includes("python") ||
      req.headers["user-agent"].includes("Go-http-client"))
  ) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const { username } = req.query;
  const { jsonData, model, language, apiKey } = req.body;

  if (!username || !language) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  // API key handling
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const geminiApiKeys = geminiApiKey.split(",");
  const randomGeminiApiKey =
    geminiApiKeys[Math.floor(Math.random() * geminiApiKeys.length)];
  let genAI = new GoogleGenerativeAI(randomGeminiApiKey);

  if (apiKey) {
    genAI = new GoogleGenerativeAI(apiKey);
  }

  // Parse client-provided data if available
  let profileData = null;
  if (jsonData) {
    try {
      profileData = JSON.parse(jsonData);
    } catch (error) {
      console.log("Failed to parse JSON data");
    }
  }

  try {
    // If no client data, scrape Instagram
    if (!profileData) {
      const profileResponse = await scrapeInstagramProfile(username);

      if (profileResponse.status === 404) {
        return res
          .status(404)
          .json({ error: "Instagram profile not found", type: "Instagram" });
      }

      if (profileResponse.status === 500) {
        return res.status(500).json({
          error: profileResponse.error || "Failed to scrape Instagram profile",
          type: "Scraping",
        });
      }

      profileData = profileResponse.data;
    }

    // Build prompt for AI based on selected language
    let prompt;
    switch (language) {
      case "english":
        prompt = `Give a short, harsh, and sarcastic roast for the Instagram profile of ${username}. Here are the profile details: ${JSON.stringify(
          profileData
        )}. Make it really savage but funny. Don't provide praise or advice, just roast them based on their profile information.`;
        break;
      case "indonesia":
        prompt = `Berikan roasting singkat dengan kejam, menyindir, serta menyakitkan dalam bahasa gaul untuk profile instagram berikut: ${username}. Berikut detailnya: ${JSON.stringify(
          profileData
        )}. Buat roastingnya sangat savage tapi tetap lucu. Jangan berikan pujian atau saran, cukup roast mereka berdasarkan informasi profile.`;
        break;
      default:
        // Auto-detect language based on profile bio
        const isEnglish = !profileData.bio?.includes("Indonesia");
        prompt = isEnglish
          ? `Give a short, harsh, and sarcastic roast for the Instagram profile of ${username}. Here are the profile details: ${JSON.stringify(
              profileData
            )}. Make it really savage but funny. Don't provide praise or advice, just roast them based on their profile information.`
          : `Berikan roasting singkat dengan kejam, menyindir, serta menyakitkan dalam bahasa gaul untuk profile instagram berikut: ${username}. Berikut detailnya: ${JSON.stringify(
              profileData
            )}. Buat roastingnya sangat savage tapi tetap lucu. Jangan berikan pujian atau saran, cukup roast mereka berdasarkan informasi profile.`;
    }

    // Generate roast
    const result = await generateContent("gemini", prompt, genAI);
    res.json({ roasting: result });
  } catch (error) {
    console.error("Error generating roast:", error);

    if (
      error instanceof GoogleGenerativeAIResponseError ||
      error instanceof GoogleGenerativeAIError
    ) {
      return res.status(500).json({ error: error.message, type: "AI" });
    }

    res.status(500).json({ error: error.message, type: "Server" });
  }
});

app.get("/scrape", async (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ error: "Username is required" });
  }

  try {
    const profileResponse = await scrapeInstagramProfile(username);

    if (profileResponse.status === 404) {
      return res.status(404).json({ error: "Instagram profile not found" });
    }

    if (profileResponse.status === 500) {
      return res.status(500).json({ error: profileResponse.error });
    }

    res.json(profileResponse.data);
  } catch (error) {
    console.error("Error scraping Instagram profile:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Instagram Roast API listening on port ${port}`);
});
