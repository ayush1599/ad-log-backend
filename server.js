import express from 'express';
import Parser from 'rss-parser';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const app = express();
const parser = new Parser();
app.use(cors());
app.use(express.json());
dotenv.config();

const FEEDS = [
  'https://www.adexchanger.com/feed/',
  'https://digiday.com/feed/',
  'https://www.adweek.com/feed/',
  'https://martech.org/feed/',
  'http://feeds.feedburner.com/Exchangewirecom',
  'https://www.mediapost.com/publications/rss/',
  'https://performancein.com/feed/',
  'https://searchengineland.com/feed',
  'https://marketingland.com/feed',
  'https://www.clickz.com/feed/',
  'https://www.campaignlive.co.uk/rss',
  'https://martechseries.com/feed/',
  'https://www.thedrum.com/rss',
  'https://www.cmswire.com/index.rss',
  'https://www.dmnews.com/feed'
];

let cache = {
  articles: [],
  timestamp: 0,
  lastFetchDate: null
};

// Function to fetch RSS feeds
async function fetchRSSFeeds() {
  console.log('🔄 Starting scheduled RSS fetch at', new Date().toLocaleString());
  try {
    let allItems = [];
    for (const url of FEEDS) {
      try {
        const feed = await parser.parseURL(url);
        const items = (feed.items || []).map(item => {
          const headline = item.title || '';
          const summary = item.contentSnippet || item.summary || '';
          return {
            headline,
            summary,
            date: item.pubDate || '',
            link: item.link || '',
            source: feed.title || '',
          };
        });
        allItems = allItems.concat(items);
      } catch (err) {
        // Log the error but continue with the next feed
        console.warn(`Failed to fetch or parse feed: ${url}`, err.message);
      }
    }
    
    // Log all article dates for debugging
    console.log('📅 Fetched article dates:', allItems.map(a => a.date));
    allItems.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    cache = { 
      articles: allItems, 
      timestamp: Date.now(),
      lastFetchDate: new Date().toISOString()
    };
    
    console.log(`✅ RSS fetch completed. Cached ${allItems.length} articles.`);
  } catch (err) {
    console.error('❌ Failed to fetch RSS feeds:', err.message);
  }
}

// Function to check if it's time to fetch (7 AM EST daily)
function shouldFetchToday() {
  const now = new Date();
  const estTime = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
  const currentHour = estTime.getHours();
  const currentDate = estTime.toDateString();
  
  // Check if it's 7 AM EST and we haven't fetched today
  return currentHour === 7 && cache.lastFetchDate !== currentDate;
}

// Function to schedule the next fetch
function scheduleNextFetch() {
  const now = new Date();
  const estTime = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
  const currentHour = estTime.getHours();
  const currentMinute = estTime.getMinutes();
  
  let nextFetchTime;
  
  if (currentHour >= 7) {
    // If it's past 7 AM, schedule for tomorrow at 7 AM
    nextFetchTime = new Date(estTime);
    nextFetchTime.setDate(nextFetchTime.getDate() + 1);
    nextFetchTime.setHours(7, 0, 0, 0);
  } else {
    // If it's before 7 AM, schedule for today at 7 AM
    nextFetchTime = new Date(estTime);
    nextFetchTime.setHours(7, 0, 0, 0);
  }
  
  const timeUntilNextFetch = nextFetchTime.getTime() - estTime.getTime();
  
  console.log(`⏰ Next RSS fetch scheduled for: ${nextFetchTime.toLocaleString()}`);
  console.log(`⏱️  Time until next fetch: ${Math.floor(timeUntilNextFetch / 1000 / 60)} minutes`);
  
  setTimeout(() => {
    fetchRSSFeeds();
    scheduleNextFetch(); // Schedule the next one
  }, timeUntilNextFetch);
}

// Modified /api/news endpoint - only serves cached data
app.get('/api/news', async (req, res) => {
  // Check if we should fetch today (7 AM EST)
  if (shouldFetchToday()) {
    console.log('🕐 It\'s 7 AM EST - triggering scheduled fetch');
    await fetchRSSFeeds();
  }
  
  // Always return cached data
  if (cache.articles.length > 0) {
    res.json({ 
      articles: cache.articles,
      lastFetch: cache.lastFetchDate,
      cacheStatus: 'serving cached data'
    });
  } else {
    // If no cached data, fetch once and cache
    console.log('📥 No cached data found, fetching once...');
    await fetchRSSFeeds();
    res.json({ 
      articles: cache.articles,
      lastFetch: cache.lastFetchDate,
      cacheStatus: 'initial fetch'
    });
  }
});

app.post('/api/summarize', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });
  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful assistant that summarizes news articles.' },
          { role: 'user', content: `Summarize the following article as 4-5 concise bullet points. Do not write a paragraph.\n\n${text}` }
        ],
        max_tokens: 300,
        temperature: 0.6
      })
    });
    const data = await openaiRes.json();
    console.log('OpenAI API response:', JSON.stringify(data, null, 2));
    const summaryRaw = data.choices?.[0]?.message?.content?.trim() || '';
    let summary = summaryRaw;
    if (summaryRaw.startsWith('-')) {
      const items = summaryRaw.split(/\n+/).map(line => line.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
      summary = `<ul style="padding-left:1.5em;list-style:disc;">` + items.map(item => `<li>${item}</li>`).join('') + `</ul>`;
    }
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: 'Failed to summarize', details: err.message });
  }
});

// OpenAI TTS endpoint with caching
app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });

  // Hash the text to use as a filename
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const cacheDir = path.join(process.cwd(), 'tts_cache');
  const cacheFile = path.join(cacheDir, `${hash}.mp3`);

  try {
    // Ensure cache directory exists
    if (!fs.existsSync(cacheDir)) {
      console.log('tts_cache directory does not exist. Creating...');
      fs.mkdirSync(cacheDir);
      console.log('tts_cache directory created.');
    } else {
      console.log('tts_cache directory already exists.');
    }

    // If cached file exists, serve it
    if (fs.existsSync(cacheFile)) {
      console.log('Serving cached audio:', cacheFile);
      const stat = fs.statSync(cacheFile);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      const readStream = fs.createReadStream(cacheFile);
      return readStream.pipe(res);
    }

    // Otherwise, call OpenAI TTS
    console.log('Calling OpenAI TTS API for new audio...');
    const openaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: 'alloy', // Options: alloy, echo, fable, onyx, nova, shimmer
        speed: 1.0
      })
    });

    if (!openaiRes.ok) {
      const errorData = await openaiRes.json();
      console.error('OpenAI TTS error:', errorData);
      return res.status(openaiRes.status).json({ error: 'TTS failed', details: errorData });
    }

    // Get the audio buffer
    const audioBuffer = Buffer.from(await openaiRes.arrayBuffer());
    // Save to cache
    try {
      fs.writeFileSync(cacheFile, audioBuffer);
      console.log('Audio file written to cache:', cacheFile);
    } catch (writeErr) {
      console.error('Error writing audio file to cache:', writeErr);
    }
    // Serve the audio
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(audioBuffer);
  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: 'Failed to generate speech', details: err.message });
  }
});

// Add this endpoint to clear cache
app.post('/api/clear-cache', (req, res) => {
  cache = { articles: [], timestamp: 0, lastFetchDate: null };
  res.json({ message: 'Cache cleared' });
});

// Manual fetch endpoint for testing
app.post('/api/fetch-now', async (req, res) => {
  console.log('🔄 Manual RSS fetch requested');
  await fetchRSSFeeds();
  res.json({ 
    message: 'Manual fetch completed',
    articlesCount: cache.articles.length,
    lastFetch: cache.lastFetchDate
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`News API server running on port ${PORT}`);
  
  // Initialize the RSS fetch scheduler
  console.log('🚀 Initializing RSS fetch scheduler...');
  
  // Do initial fetch if no cached data
  if (cache.articles.length === 0) {
    console.log('📥 No cached data found, performing initial fetch...');
    fetchRSSFeeds().then(() => {
      scheduleNextFetch();
    });
  } else {
    console.log('✅ Cached data found, scheduling next fetch...');
    scheduleNextFetch();
  }
}); 