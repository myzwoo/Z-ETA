import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const xmlParser = new XMLParser();

async function startServer() {
  const app = express();
  const PORT = 3000;

  const KAKAO_KEY = process.env.KAKAO_REST_API_KEY;
  const SEOUL_API_KEY = process.env.SEOUL_API_KEY;
  const BUS_API_KEY = process.env.BUS_API_KEY;

  if (!KAKAO_KEY) {
    console.warn('WARNING: KAKAO_REST_API_KEY is not set. Transit features will fail.');
  }
  if (!SEOUL_API_KEY) {
    console.warn('WARNING: SEOUL_API_KEY is not set.');
  }

  app.use(express.json());

  // API Route: Subway Real-time Arrival
  app.get('/api/subway', async (req, res) => {
    try {
      const { station } = req.query;
      if (!station) return res.status(400).json({ error: 'Station name is required' });

      console.log(`[Subway] Fetching arrivals for: ${station}`);
      const url = `http://swopenAPI.seoul.go.kr/api/subway/${SEOUL_API_KEY}/json/realtimeStationArrival/0/10/${encodeURIComponent(station as string)}`;
      const response = await axios.get(url);
      
      res.json(response.data);
    } catch (error: any) {
      console.error('Subway API error:', error.message);
      const status = error.response?.status || 500;
      const data = error.response?.data || { error: 'Failed to fetch subway info' };
      res.status(status).json(typeof data === 'string' ? { error: data } : data);
    }
  });

  // API Route: Bus Real-time Arrival
  app.get('/api/bus', async (req, res) => {
    try {
      const { arsId, busNum } = req.query;
      if (!arsId) return res.status(400).json({ error: 'arsId is required' });

      console.log(`[Bus] Fetching info for Station: ${arsId}`);
      const url = `http://ws.bus.go.kr/api/rest/stationinfo/getStationByUid?ServiceKey=${BUS_API_KEY}&arsId=${arsId}`;
      const response = await axios.get(url, { responseType: 'text' });
      
      const jsonData = xmlParser.parse(response.data);
      const itemList = jsonData?.ServiceResult?.msgBody?.itemList;
      
      let result = Array.isArray(itemList) ? itemList : (itemList ? [itemList] : []);
      // We keep tmX/tmY for coordinate calculations
      if (busNum) {
        // Keep all items if we need coordinates of the station, 
        // but if filtering by bus for arrival msg, we return consistent format
        const filtered = result.filter((item: any) => String(item.rtNm) === String(busNum));
        res.json(filtered.length > 0 ? filtered : result); // Fallback to all if bus not found
      } else {
        res.json(result);
      }
    } catch (error: any) {
      console.error('Bus API error:', error.message);
      res.status(500).json({ error: 'Failed to fetch bus info' });
    }
  });

  // API Route: Keyword Search (Generic)
  app.get('/api/search-keyword', async (req, res) => {
    try {
      const { query } = req.query;
      if (!query) return res.status(400).json({ error: 'Query is required' });

      console.log(`[Keyword Search] Querying: ${query}`);
      const response = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json', {
        params: { query },
        headers: { Authorization: `KakaoAK ${KAKAO_KEY}` }
      });

      res.json(response.data);
    } catch (error: any) {
      console.error('Keyword search error:', error.message);
      res.status(500).json({ error: 'Failed to search keyword' });
    }
  });

  // API Route: Subway Station Info (Coordinates)
  app.get('/api/subway-station', async (req, res) => {
    try {
      const { station } = req.query;
      if (!station) return res.status(400).json({ error: 'Station name is required' });

      // Search via Kakao Keyword search for coordinates as it's more reliable for locations
      const response = await axios.get('https://dapi.kakao.com/v2/local/search/keyword.json', {
        params: { query: `${station}역` },
        headers: { Authorization: `KakaoAK ${KAKAO_KEY}` }
      });

      res.json(response.data.documents?.[0] || {});
    } catch (error: any) {
      console.error('Subway Search error:', error.message);
      res.status(500).json({ error: 'Failed to search subway station' });
    }
  });

  // API Route: Address Search (Geocoding)
  app.get('/api/search-address', async (req, res) => {
    try {
      const { query } = req.query;
      if (!query) return res.status(400).json({ error: 'Query is required' });

      console.log(`[Geocoding] Searching for: ${query}`);
      const response = await axios.get('https://dapi.kakao.com/v2/local/search/address', {
        params: { query },
        headers: { Authorization: `KakaoAK ${KAKAO_KEY}` }
      });

      console.log(`[Geocoding] Found ${response.data.documents?.length || 0} results`);
      res.json(response.data);
    } catch (error: any) {
      const errData = error.response?.data;
      console.error('Geocoding error:', errData || error.message);
      const status = error.response?.status || 500;
      res.status(status).json(errData || { error: 'Failed to search address', message: error.message });
    }
  });

  // API Route: Transit Route Search
  app.get('/api/search-route', async (req, res) => {
    try {
      const { sX, sY, sName, eX, eY, eName } = req.query;
      if (!sX || !sY || !eX || !eY) return res.status(400).json({ error: 'Coordinates are required' });

      console.log(`[Route] Searching: ${sName}(${sX},${sY}) -> ${eName}(${eX},${eY})`);
      
      // Kakao Transit API v1
      const response = await axios.get('https://apis-navi.kakaomobility.com/v1/directions/transit', {
        params: {
          origin: `${sX},${sY}${sName ? ',' + sName : ''}`,
          destination: `${eX},${eY}${eName ? ',' + eName : ''}`
        },
        headers: { Authorization: `KakaoAK ${KAKAO_KEY}` }
      });

      res.json(response.data);
    } catch (error: any) {
      const errData = error.response?.data;
      console.error('Route search error:', errData || error.message);
      res.status(500).json(errData || { error: 'Failed to search route' });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
