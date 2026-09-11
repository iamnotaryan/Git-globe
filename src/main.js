import './style.css';
import Globe from 'globe.gl';
import { getEvents } from './github.js';


function normalizeLocation(location) {
  return location
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/-/g, ' ')
    .trim();
}

async function init() {
  const TOKEN = import.meta.env.VITE_GITHUB_TOKEN;
  const countriesResponse = await fetch('/countries.geo.json');
  const countries = await countriesResponse.json();
  const response = await fetch('/world_cities.json');
  const cities = await response.json();
  let events = [];
  try {
    events = await getEvents();
    let allEvents = [];

    for (let page = 1; page <= 5; page++) {
      const response = await fetch(
        `https://api.github.com/events?per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${TOKEN}`
          }
        }
      );

      const data = await response.json();
      allEvents.push(...data);
    }

    console.log(events);
    console.log(events.length);
    
  } catch (err) {
    console.error(err);
  }
  
  const githubUsers = [];
  for (const event of events) {
    const username = event.actor.login;
    
    const TOKEN = import.meta.env.VITE_GITHUB_TOKEN;
    
    const response = await fetch(
      `https://api.github.com/users/${username}`,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          Accept: 'application/vnd.github+json'
        }
      }
    );
    
    
    const user = await response.json();
    
    if (user.location) {
      githubUsers.push({
        username,
        location: user.location,
        eventType: event.type
      });
    }
  }
  const matchedUsers = [];
  for (const user of githubUsers) {
    const location = normalizeLocation(user.location);
    const countryFallbacks = {
      "united states": "New York",
      "india": "Delhi",
      "china": "Shanghai",
      "japan": "Tokyo",
      "brazil": "São Paulo",
      "germany": "Berlin"
    };
    
    
    const city = cities.find(c =>
      location.includes(c.name.toLowerCase())
    );
    if (!city) {
      const fallback = countryFallbacks[location];
      
      if (fallback) {
        city = cities.find(
          c => c.name.toLowerCase() === fallback.toLowerCase()
        );
      }
    }
    
    if (city) {
      matchedUsers.push({
        username: user.username,
        eventType: user.eventType,
        lat: Number(city.lat),
        lng: Number(city.lng)
      });
    } else {
      console.log("No match:", user.location);
    }
  }
  
  console.log(matchedUsers);
  console.log("GitHub Users:", githubUsers.length);
  console.log("Matched Users:", matchedUsers.length);
  console.log(events);
  console.log(events.length);
  console.log("Loaded cities:", cities.length);
  console.log(countries);
  console.log(countries.features);
  console.log(countries.features.length);
  for (const user of githubUsers) {
    console.log(user.location);
  }
  
  
  
  const globe = Globe()
  
  
  .pointsData(matchedUsers)
  .pointLat('lat')
  .pointLng('lng')
  .pointRadius(0.5)
  .pointColor(d => {
    switch (d.eventType) {
      case 'PushEvent':
        return '#00ff88';
        
        case 'PullRequestEvent':
          return '#00ffff';
          
          case 'WatchEvent':
            return '#ffff00';
            
            default:
              return '#ffffff';
            }
          })
          
          .pointLat('lat')
          .pointLng('lng')
          .pointsData(matchedUsers)
          .pointRadius(0.4)
          .polygonsData(countries.features)
          .polygonCapColor(country => {
            return '#000000';
          })
          .polygonSideColor(() => 'rgba(4, 4, 4, 0)')
  .polygonStrokeColor(() => '#f44242b1')
  .polygonAltitude(0.005)
  .ringsData(matchedUsers)
  .ringColor(() => '#00ff88')
  .ringMaxRadius(4)
  .ringPropagationSpeed(3)
  .ringRepeatPeriod(1200)
  .pointLabel(d =>
    `${d.username}<br>${d.eventType}`
  )
  globe.globeMaterial().color.set('#000000');
  
  globe.atmosphereColor('#1aebe4');
  globe.atmosphereAltitude(0.15);
  
  // globe.globeMaterial().wireframe = true;
  globe(document.getElementById('globeViz'));
  
  globe.controls().autoRotate = true;
  globe.controls().autoRotateSpeed = 0.5;
  return allEvents;
}

init();