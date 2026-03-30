const express = require('express');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const crypto = require('crypto');
const axios = require('axios');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { normalizeHost, resolveTenantFromHost, tenantHostnames } = require('./utils/tenant-host-resolver');

function safeRequire(mod) {
  try { return require(mod); } catch (e) { return null; }
}
const nodemailer = safeRequire('nodemailer');
const StripeLib  = safeRequire('stripe');
