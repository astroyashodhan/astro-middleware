# Astro Middleware

Receives Interakt workflow webhooks, parses the data, and forwards clean JSON to Make.com.

## Deploy to Railway

1. Push this repo to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Select this repo
4. Add environment variable:
   - `MAKE_WEBHOOK_URL` = your Make.com webhook URL
5. Deploy → copy the Railway URL

## Set in Interakt

In Interakt Developer Settings → Webhooks:
- URL: `https://your-railway-url/webhook`
- Event: `workflow_response_update`

## Payload sent to Make.com

```json
{
  "name": "Shivakiran",
  "dob": "20 February 1993",
  "birth_place": "Hubli",
  "tob": "1:30pm",
  "topic": "2",
  "phone_full": "+919019497839",
  "customer_name": "Shivakiran",
  "customer_id": "...",
  "workflow_id": "...",
  "timestamp": "..."
}
```
