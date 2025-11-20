# Trade-Room Bid Comparison - Setup Guide

## 🎯 New Feature: Sourcing Master List Bid Analysis

**What it does:**
- Reads "🛒 Sourcing Master List" database
- Groups bids by Trade (Category) and Room
- Finds lowest and highest bids per group
- Returns vendor comparison data

---

## 📋 Setup Instructions

### STEP 1: Add Environment Variable to Netlify

1. **Go to:** https://app.netlify.com/sites/YOUR-SITE/settings/env

2. **Click "Add a variable"**

3. **Add:**
   ```
   Name: SOURCING_MASTER_LIST_DB_ID
   Value: b84fa0c4cc8d4144afc43aa8dd894931
   ```

4. **Save**

---

### STEP 2: Grant Integration Access

1. **Open database:** https://www.notion.so/b84fa0c4cc8d4144afc43aa8dd894931

2. **Click "..." menu** (top right)

3. **Click "Add connections"**

4. **Select your Notion integration** (same one with NOTION_API_KEY)

5. **Click "Confirm"**

---

### STEP 3: Deploy Updated Proxy

**Download latest proxy.mjs:** https://api.runable.com/s/YOUR_NEW_LINK

**Deploy via GitHub:**
1. Go to: https://github.com/sinha03-art/Joobin-Dashboard/blob/main/netlify/functions/proxy.mjs
2. Click pencil (Edit)
3. Copy code from download link
4. Paste into GitHub
5. Commit: "Add /bids endpoint for trade-room comparison"

**Or via command line:**
```bash
cd ~/desktop/joobin-dashboard
curl -L -o netlify/functions/proxy.mjs <DOWNLOAD_LINK>
git add netlify/functions/proxy.mjs
git commit -m "Add /bids endpoint for trade-room comparison"
git push origin main
```

---

### STEP 4: Trigger Deploy

1. **Go to:** https://app.netlify.com/sites/YOUR-SITE/deploys
2. **Click** "Trigger deploy" → "Clear cache and deploy site"
3. **Wait** 2-3 minutes

---

### STEP 5: Test the Endpoint

**Visit in browser:**
```
https://YOUR-SITE.netlify.app/.netlify/functions/proxy/bids
```

**Expected response:**
```json
{
  "success": true,
  "data": {
    "trade_room_comparisons": [
      {
        "trade": "Cabinetry",
        "room": "Wet Kitchen",
        "vendor_count": 3,
        "price_range": 5000,
        "lowest_bid": {
          "vendor": "Vendor A",
          "total_price_myr": 12000,
          "unit_price_myr": 150,
          "quantity": 80,
          "item_name": "...",
          "coverage": "m²",
          "notes": "MYR (native)",
          "url": "..."
        },
        "highest_bid": {
          "vendor": "Vendor B",
          "total_price_myr": 17000,
          ...
        },
        "all_bids": [ ... sorted by price ... ]
      }
    ],
    "total_groups": 25,
    "total_bids": 150
  },
  "timestamp": "2025-11-19T..."
}
```

---

## 🔍 How It Works

### Data Flow:
1. Queries "Sourcing Master List" database
2. Reads these fields from each row:
   - Item Name
   - Category (= trade)
   - Room
   - Vendor
   - Quantity
   - Unit Price (MYR)
   - Total Price (MYR) (formula)
   - Coverage
   - Notes

3. Computes effective_total:
   - Use Total Price if available
   - Else: Quantity × Unit Price
   - Else: Unit Price (for ordering)

4. Groups by (Category, Room)

5. Per group:
   - Sorts by effective_total ascending
   - Identifies lowest (first) and highest (last)
   - Returns all bids sorted

### Edge Cases Handled:
- ✅ Missing quantities (uses unit price for comparison)
- ✅ Missing totals (computes from unit × qty)
- ✅ No price data (skipped)
- ✅ Multiple vendors per trade-room (keeps all)
- ✅ Ties on price (uses insertion order)

---

## 📊 Required Database Schema

**Sourcing Master List must have these columns:**

| Column Name | Type | Required | Notes |
|------------|------|----------|-------|
| Item Name | Text/Title | ✅ | Description of item |
| Category | Select/Text | ✅ | Trade category |
| Room | Select/Text | ✅ | Room location |
| Vendor | Text | ✅ | Vendor name |
| Quantity | Number | Recommended | Can be 0/null for rate-only |
| Unit Price (MYR) | Number | ✅ | Price per unit |
| Total Price (MYR) | Number/Formula | Recommended | Qty × Unit Price |
| Coverage | Text | Optional | Unit type (m², pcs, etc) |
| Notes | Text | Optional | Currency notes |

---

## 🧪 Testing Checklist

After deployment:

- [ ] Endpoint accessible at `/.netlify/functions/proxy/bids`
- [ ] Returns `success: true`
- [ ] Contains `trade_room_comparisons` array
- [ ] Each group has `lowest_bid` and `highest_bid`
- [ ] `all_bids` sorted ascending by price
- [ ] Vendor names appear correctly
- [ ] Prices match Notion data
- [ ] Groups organized by trade + room

---

## 🚀 Usage in Frontend

**Fetch bid data:**
```javascript
const response = await fetch('/.netlify/functions/proxy/bids');
const data = await response.json();

// Access trade-room comparisons
data.data.trade_room_comparisons.forEach(comparison => {
    console.log(`${comparison.trade} - ${comparison.room}`);
    console.log('  Lowest:', comparison.lowest_bid.vendor, 
                'RM', comparison.lowest_bid.total_price_myr);
    console.log('  Highest:', comparison.highest_bid.vendor, 
                'RM', comparison.highest_bid.total_price_myr);
});
```

**Filter by trade:**
```javascript
const cabinetryBids = data.data.trade_room_comparisons
    .filter(c => c.trade === 'Cabinetry');
```

---

## 🔮 Future Enhancements

1. **Query parameters:**
   - `/bids?trade=Cabinetry`
   - `/bids?room=Wet Kitchen`
   - `/bids?vendor=Bespoke Kitchen`

2. **Pagination:**
   - `/bids?page=1&limit=20`

3. **Filters:**
   - `/bids?currency=native` (filter by Notes field)
   - `/bids?min_price=1000&max_price=50000`

4. **Additional metrics:**
   - Average price per trade-room
   - Median bid
   - Standard deviation

---

## ⚠️ Important Notes

- Database ID is **hardcoded as fallback** in function (b84fa0c4cc8d4144afc43aa8dd894931)
- For production, always set SOURCING_MASTER_LIST_DB_ID in Netlify env
- Cache-Control: no-store (always fresh data)
- Returns empty array if database has no data or integration not connected

---

## 📝 Environment Variables Summary

**Now required in Netlify:**
```bash
NOTION_API_KEY=<your-secret>
SOURCING_MASTER_LIST_DB_ID=b84fa0c4cc8d4144afc43aa8dd894931
FLOORING_GEORGE_A_DB_ID=2ead35d0abcd4c59b6bd57a53cb5b15f
FLOORING_GEORGE_B_DB_ID=e85e3986628545f78b56b2945e13b970
BATHROOM_SANITARY_DB_ID=44133ee42347438aa12a2d39ab1e6286
BATHROOM_TILES_DB_ID=003a3be27027415eb6b755f3c4ad23e7
QUOTATIONS_HUB_ID=f592fb65f394464184ad6656e19ed460
MATERIAL_IMAGES_DB_ID=2d5406bb097f437db445669524db0217
```

**Plus all existing main dashboard vars** (NOTION_BUDGET_DB_ID, etc.)
