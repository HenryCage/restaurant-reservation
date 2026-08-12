Step 1: Start the servers
npm run dev - for backend
cd client then npm run dev - for frontend

Step: 2 - Create a superadmin
node scripts/create-user.mjs --email=admin@example.com --superadmin --password=TempPassword123

Step 3: Change Password (If possible use Postman)
Method: POST
URL: http://localhost:3000/auth/change-password
Body:
{
"currentPassword": "TempPassword123",
"newPassword": "the new password"
}

Step 4: Login as Admin
Method: POST
URL: http://localhost:3000/auth/login
Body:
{
"email": "admin@example.com",
"password": "the new password"
}

Step 5: Create the Tenant
http://localhost:3000/api/tenants
Method: POST
Body:
{
"id": "test-restaurant",
"name": "A Restaurant for Testing",
"active": true,
"sheetId": "reservation-only",
"sheetName": "Orders",
"senderId": "RESTAURANT",
"channel": "dnd",
"defaultCountryCode": "234",
"notifyStatuses": ["Confirmed"],
"templates": {
"Confirmed": "Hi {name}, your booking is confirmed."
},
"smsProvider": "twilio",
"smsCredentials": {
"accountSid": "twilio account sid",
"authToken": "twilio auth token",
"fromNumber": "twilio from number"
}
}

Step 6: Send the Reservation
http://localhost:5173
