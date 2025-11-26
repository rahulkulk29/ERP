// backend/server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const DatabaseManager = require('./utils/databaseManager');
require('dotenv').config();
const path = require('path'); // Import path module
const multer = require('multer'); // <-- Import multer
const fs = require('fs'); // Import fs module for file operations
const http = require('http'); // For Socket.IO
const { Server } = require('socket.io'); // Socket.IO server

// Import your controller
const exportImportController = require('./controllers/exportImportController'); // <-- Import exportImportController

// Import middleware
const { auth } = require('./middleware/auth'); // <-- Import auth middleware (adjust path if needed)
const { setMainDbContext } = require('./middleware/schoolContext'); // <-- Import context middleware (adjust path if needed)


const app = express();
const PORT = process.env.PORT || 5050;

// Create HTTP server for Socket.IO
const server = http.createServer(app);

// Initialize Socket.IO with CORS
const io = new Server(server, {
  cors: {
    origin: [
      'http://localhost:3000',
      'http://localhost:8081',
      'http://localhost:5173',
      'https://erp-host-1.web.app',
      'https://erp-host-1.firebaseapp.com',
      'https://erpedulogix.web.app',
      'https://jayesh-erp.web.app',
      'https://erpedulogix.firebaseapp.com',
      'https://erp-backend-1jtx.onrender.com',
      // Expo mobile app origins
      'exp://localhost:8081',
      'exp://*',
      'capacitor://localhost',
      'ionic://localhost'
    ],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('🔌 Client connected:', socket.id);

  // Join school-specific room
  socket.on('join-school', (schoolCode) => {
    // Normalize to lowercase for consistent room names
    const normalizedSchoolCode = schoolCode.toLowerCase();
    socket.join(`school-${normalizedSchoolCode}`);
    console.log(`📚 Socket ${socket.id} joined school room: school-${normalizedSchoolCode} (original: ${schoolCode})`);

    // Log all sockets in this room
    const room = io.sockets.adapter.rooms.get(`school-${normalizedSchoolCode}`);
    console.log(`📊 Total sockets in school-${normalizedSchoolCode}:`, room ? room.size : 0);
    if (room) {
      console.log(`📊 Socket IDs in room:`, Array.from(room));
    }
  });

  // Handle SOS alert from student
  socket.on('student-sos', async (data) => {
    console.log('🚨 SOS Alert received:', data);
    const { schoolCode, studentId, studentName, studentClass, studentRollNo, location } = data;

    try {
      // Validate required fields
      if (!schoolCode) {
        throw new Error('School code is required');
      }
      if (!studentId) {
        throw new Error('Student ID is required');
      }
      if (!studentName) {
        throw new Error('Student name is required');
      }

      console.log('📡 Getting school connection for:', schoolCode);
      // Get school connection and save SOS alert to database
      const schoolConn = await DatabaseManager.getSchoolConnection(schoolCode);

      if (!schoolConn) {
        throw new Error(`Failed to get database connection for school: ${schoolCode}`);
      }

      console.log('📝 Creating SOS Alert model...');
      const SOSAlert = require('./models/SOSAlert').getModelForConnection(schoolConn);

      // Try to fetch student details from database if class/rollNo/mobile are missing
      let finalClass = studentClass || 'N/A';
      let finalRollNo = studentRollNo || 'N/A';
      let finalMobile = 'N/A';

      if (finalClass === 'N/A' || finalRollNo === 'N/A') {
        try {
          console.log('🔍 Fetching student details from database for:', studentId);
          const studentCollection = schoolConn.collection('students');
          const mongoose = require('mongoose');

          // Try to convert to ObjectId if it's a valid ObjectId string
          let objectId = null;
          try {
            objectId = new mongoose.Types.ObjectId(studentId);
          } catch (e) {
            console.log('🔍 studentId is not a valid ObjectId, will search by userId');
          }

          const studentDoc = await studentCollection.findOne({
            $or: [
              objectId ? { _id: objectId } : null,
              { userId: studentId },
              { _id: studentId }
            ].filter(Boolean)
          });

          if (studentDoc) {
            console.log('✅ Found student document!');
            console.log('✅ Student fields:', Object.keys(studentDoc));
            console.log('✅ studentDetails:', studentDoc.studentDetails);

            // Extract class from various possible locations
            finalClass = studentDoc.studentDetails?.currentClass ||  // ← Primary location
              studentDoc.studentDetails?.class ||
              studentDoc.class ||
              studentDoc.academicInfo?.class ||
              finalClass;

            // Extract roll number from various possible locations  
            finalRollNo = studentDoc.studentDetails?.rollNumber ||
              studentDoc.studentDetails?.rollNo ||
              studentDoc.rollNumber ||
              studentDoc.rollNo ||
              studentDoc.userId ||
              finalRollNo;

            // Extract mobile number from various possible locations
            finalMobile = studentDoc.contact?.primaryPhone ||
              studentDoc.studentDetails?.fatherPhone ||
              studentDoc.studentDetails?.motherPhone ||
              studentDoc.fatherPhone ||
              studentDoc.motherPhone ||
              studentDoc.phone ||
              'N/A';

            console.log('✅ Extracted class:', finalClass);
            console.log('✅ Extracted rollNo:', finalRollNo);
            console.log('✅ Extracted mobile:', finalMobile);
          } else {
            console.log('⚠️ Student document not found in database');
            console.log('⚠️ Tried queries with studentId:', studentId);
          }
        } catch (err) {
          console.error('❌ Error fetching student details:', err.message);
          console.error('❌ Error stack:', err.stack);
        }
      }

      const sosAlertData = {
        schoolCode,
        studentId,
        studentName,
        studentClass: finalClass,
        studentRollNo: finalRollNo,
        studentMobile: finalMobile,
        location: location || 'Unknown',
        status: 'active',
        timestamp: new Date()
      };

      console.log('💾 Saving SOS Alert:', sosAlertData);
      const sosAlert = new SOSAlert(sosAlertData);

      await sosAlert.save();
      console.log('✅ SOS Alert saved to database:', sosAlert._id);

      // Broadcast to all admins in the school
      const alertPayload = {
        id: sosAlert._id.toString(),
        schoolCode,
        studentId,
        studentName,
        studentClass: finalClass,
        studentRollNo: finalRollNo,
        studentMobile: finalMobile,
        location: location || 'Unknown',
        status: 'active',
        timestamp: sosAlert.timestamp
      };

      // Check how many sockets are in the room before broadcasting
      // Normalize to lowercase for consistent room names
      const normalizedSchoolCode = schoolCode.toLowerCase();
      const room = io.sockets.adapter.rooms.get(`school-${normalizedSchoolCode}`);
      console.log(`📢 Broadcasting to school-${normalizedSchoolCode} (original: ${schoolCode})`);
      console.log(`📢 Sockets in room:`, room ? room.size : 0);
      if (room) {
        console.log(`📢 Socket IDs:`, Array.from(room));
      }

      io.to(`school-${normalizedSchoolCode}`).emit('sos-alert', alertPayload);
      console.log(`✅ SOS Alert broadcasted to school-${schoolCode}`);
      console.log(`✅ Alert payload:`, JSON.stringify(alertPayload, null, 2));

      // Send success confirmation back to student
      socket.emit('sos-success', { message: 'SOS alert sent successfully', alertId: sosAlert._id });
    } catch (error) {
      console.error('❌ Error handling SOS alert:', error);
      console.error('❌ Error stack:', error.stack);
      console.error('❌ Error details:', {
        message: error.message,
        name: error.name,
        code: error.code
      });
      socket.emit('sos-error', {
        message: 'Failed to process SOS alert',
        details: error.message
      });
    }
  });

  // Handle SOS acknowledgment from admin
  socket.on('acknowledge-sos', async (data) => {
    const { alertId, schoolCode, adminId, adminName } = data;

    try {
      const schoolConn = await DatabaseManager.getSchoolConnection(schoolCode);
      const SOSAlert = require('./models/SOSAlert').getModelForConnection(schoolConn);

      await SOSAlert.findByIdAndUpdate(alertId, {
        status: 'acknowledged',
        acknowledgedBy: adminId,
        acknowledgedAt: new Date()
      });

      // Notify all admins that SOS was acknowledged
      io.to(`school-${schoolCode}`).emit('sos-acknowledged', {
        alertId,
        adminName,
        timestamp: new Date()
      });

      console.log(`✅ SOS Alert ${alertId} acknowledged by ${adminName}`);
    } catch (error) {
      console.error('❌ Error acknowledging SOS:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('🔌 Client disconnected:', socket.id);
  });
});

// Make io available to routes
app.set('io', io);

// Middleware
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:8081', // Expo web development server
      'https://erp-host-1.web.app',
      'https://erp-host-1.firebaseapp.com',
      'https://erpedulogix.web.app',
      'https://jayesh-erp.web.app',
      'https://erpedulogix.firebaseapp.com',
      'https://erp-backend-1jtx.onrender.com',// Add the production backend URL
      'http://localhost:5173',
      // Expo mobile app origins
      'exp://localhost:8081',
      'capacitor://localhost',
      'ionic://localhost'
    ];

    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('❌ CORS blocked for:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  // Allow both header casings for full robustness
  allowedHeaders: ['Content-Type', 'Authorization', 'x-school-code', 'X-School-Code']
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true })); // Added for handling form data potentially from import

// Configure multer for file uploads
// Make sure the 'uploads/' directory exists in your backend folder
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// Request logging middleware - only log non-health/info endpoints
app.use((req, res, next) => {
  // Skip logging for health checks and frequent polling endpoints
  if (!req.originalUrl.includes('/health') &&
    !req.originalUrl.includes('/school-info') &&
    !req.originalUrl.includes('/stats')) {
    console.log(`📝 ${req.method} ${req.originalUrl}`);
  }
  next();
});

// Middleware to attach mainDb to req
app.use((req, res, next) => {
  req.mainDb = mongoose.connection.db;
  next();
});

// Middleware to verify admin/superadmin access
const requireAdminAccess = (req, res, next) => {
  // Check if req.user exists and has the required role
  if (req.user && ['admin', 'superadmin'].includes(req.user.role)) {
    return next(); // User has access, proceed
  }
  // Access denied
  console.warn(`[AUTH] Access denied for user ${req.user?._id} with role ${req.user?.role} to admin route ${req.originalUrl}`);
  return res.status(403).json({
    success: false,
    message: 'Access denied. Admin privileges required.'
  });
};

// Import other routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const admissionRoutes = require('./routes/admissions');
const attendanceRoutes = require('./routes/attendance');
const subjectRoutes = require('./routes/subjects');
const classSubjectsRoutes = require('./routes/classSubjects');
const timetableRoutes = require('./routes/timetables');
const resultRoutes = require('./routes/results');
const configRoutes = require('./routes/config');
const testDetailsRoutes = require('./routes/testDetails');
const superadminAcademicRoutes = require('./routes/superadminAcademic');
const superadminSubjectRoutes = require('./routes/superadminSubject');
const superadminClassRoutes = require('./routes/superadminClasses');
const superadminTestRoutes = require('./routes/superadminTests');
const userManagementRoutes = require('./routes/userManagement');
const adminClassRoutes = require('./routes/adminClasses');
const classesRoutes = require('./routes/classes');
const messagesRoutes = require('./routes/messages');
const feesRoutes = require('./routes/fees');
const reportsRoutes = require('./routes/reports');
const promotionRoutes = require('./routes/promotion');
const academicYearRoutes = require('./routes/academicYear');
const migrationRoutes = require('./routes/migration');
const leaveRoutes = require('./routes/leaveRoutes');
const chalanRoutes = require('./routes/chalanRoutes');

// Route imports - some routes need upload middleware
const schoolRoutes = require('./routes/schools');
const schoolUserRoutes = require('./routes/schoolUsers')(upload);
const assignmentRoutes = require('./routes/assignments')(upload);
const idCardTemplateRoutes = require('./routes/idCardTemplates')(upload);
const permissionsRoutes = require('./routes/permissions');

// Serve uploads statically
// app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve ID card templates statically
// app.use('/idcard-templates', express.static(path.join(__dirname, 'idcard-templates')));

// Test endpoint for debugging
app.get('/api/test-endpoint', (req, res) => {
  console.log('[TEST ENDPOINT] Request received');
  console.log('[TEST ENDPOINT] Headers:', req.headers);
  return res.status(200).json({
    success: true,
    message: 'Test endpoint working',
    timestamp: new Date().toISOString()
  });
});


// Direct test endpoint for class subjects
app.get('/api/direct-test/class-subjects/:className', async (req, res) => {
  try {
    let schoolCode = req.headers['x-school-code'] || req.query.schoolCode;
    if (req.user && req.user.schoolCode) { schoolCode = req.user.schoolCode; }
    if (!schoolCode) { schoolCode = req.query.schoolCode; }
    if (!schoolCode) { return res.status(400).json({ success: false, message: 'School code is required.' }); }

    // CRITICAL FIX: Normalize schoolCode to UPPERCASE for consistent querying
    schoolCode = schoolCode.toUpperCase();

    console.log('[DIRECT TEST] Request received for class:', req.params.className, 'in school:', schoolCode);
    const className = req.params.className;
    const academicYear = req.query.academicYear || '2024-25';
    const schoolConn = await DatabaseManager.getSchoolConnection(schoolCode);
    const ClassSubjectsSimple = require('./models/ClassSubjectsSimple');
    const SchoolClassSubjects = ClassSubjectsSimple.getModelForConnection(schoolConn);

    console.log(`[DIRECT TEST] Looking for class "${className}" in school "${schoolCode}"`);
    const classSubjects = await SchoolClassSubjects.findOne({ schoolCode, className, academicYear, isActive: true });

    if (!classSubjects) {
      console.log(`[DIRECT TEST] Class "${className}" not found in school "${schoolCode}"`);
      return res.status(404).json({ success: false, message: `Class "${className}" not found` });
    }
    console.log(`[DIRECT TEST] Found class "${className}"`);
    return res.status(200).json({
      success: true, message: 'Direct test successful',
      data: {
        classId: classSubjects._id, className: classSubjects.className, grade: classSubjects.grade, section: classSubjects.section,
        academicYear: classSubjects.academicYear, schoolCode: schoolCode,
        subjects: classSubjects.subjects.filter(s => s.isActive).map(s => ({ name: s.name, isActive: s.isActive }))
      }
    });
  } catch (error) {
    console.error('[DIRECT TEST] Error:', error);
    return res.status(500).json({ success: false, message: 'Direct test failed', error: error.message });
  }
});

// Direct test endpoint for assignments
app.get('/api/direct-test/assignments', async (req, res) => {
  try {
    let schoolCode = req.headers['x-school-code'] || req.query.schoolCode;
    if (req.user && req.user.schoolCode) { schoolCode = req.user.schoolCode; }
    if (!schoolCode) { schoolCode = req.query.schoolCode; }
    if (!schoolCode) { return res.status(400).json({ success: false, message: 'School code is required.' }); }

    // CRITICAL FIX: Normalize schoolCode to UPPERCASE for consistent querying
    schoolCode = schoolCode.toUpperCase();

    console.log('[DIRECT TEST ASSIGNMENTS] Request received for school:', schoolCode);
    const schoolConn = await DatabaseManager.getSchoolConnection(schoolCode);
    const AssignmentMultiTenant = require('./models/AssignmentMultiTenant');
    const SchoolAssignment = AssignmentMultiTenant.getModelForConnection(schoolConn);

    console.log(`[DIRECT TEST ASSIGNMENTS] Looking for assignments in school "${schoolCode}"`);
    const assignments = await SchoolAssignment.find({ schoolCode, isPublished: true }).sort({ createdAt: -1 });

    console.log(`[DIRECT TEST ASSIGNMENTS] Found ${assignments.length} assignments`);
    return res.status(200).json({ success: true, message: `Found ${assignments.length} assignments`, assignments, schoolCode });
  } catch (error) {
    console.error('[DIRECT TEST ASSIGNMENTS] Error:', error);
    return res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
});

// Use other routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/schools', schoolRoutes);
app.use('/api/school-users', schoolUserRoutes);
app.use('/api/admissions', admissionRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/subjects', subjectRoutes);
app.use('/api/timetables', timetableRoutes);
app.use('/api/results', resultRoutes);
app.use('/api/config', configRoutes);
app.use('/api/test-details', testDetailsRoutes);
app.use('/api/superadmin/academic', superadminAcademicRoutes);
app.use('/api/superadmin/subjects', superadminSubjectRoutes);
app.use('/api/superadmin/classes', superadminClassRoutes);
app.use('/api/superadmin/tests', superadminTestRoutes);
app.use('/api/user-management', userManagementRoutes);
app.use('/api/admin/classes', adminClassRoutes);
app.use('/api/admin/promotion', promotionRoutes);
app.use('/api/admin/academic-year', academicYearRoutes);
app.use('/api/admin/migration', migrationRoutes);
app.use('/api/classes', classesRoutes);
app.use('/api/class-subjects', classSubjectsRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/fees', feesRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/leave-requests', leaveRoutes);
app.use('/api/id-card-templates', idCardTemplateRoutes);
app.use('/api/chalans', chalanRoutes);
app.use('/api/permissions', permissionsRoutes);


// --- Define Export/Import Routes Directly ---

// Generate Template Route
// GET /api/export-import/:schoolCode/template?role=student
app.get('/api/export-import/:schoolCode/template',
  auth,               // 1. Authenticate the user
  setMainDbContext,   // 2. Set DB context (might not be strictly needed if controller fetches schoolId again)
  requireAdminAccess, // 3. Check if user is admin/superadmin
  exportImportController.generateTemplate // 4. Call the controller function
);

// Import Users Route
// POST /api/export-import/:schoolCode/import
app.post('/api/export-import/:schoolCode/import',
  auth,               // 1. Authenticate
  setMainDbContext,   // 2. Set DB context
  requireAdminAccess, // 3. Check role
  upload.single('file'), // 4. Use multer middleware to handle the 'file' upload
  exportImportController.importUsers // 5. Call the controller function
);

// Export Users Route
// GET /api/export-import/:schoolCode/export?role=student&format=csv
app.get('/api/export-import/:schoolCode/export',
  auth,               // 1. Authenticate
  setMainDbContext,   // 2. Set DB context
  requireAdminAccess, // 3. Check role
  exportImportController.exportUsers // 4. Call the controller function
);

// --- End Export/Import Routes ---


// Root path handler - return API info instead of 404
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'ERP Backend API',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/api/health',
      auth: '/api/auth',
      users: '/api/users',
      schools: '/api/schools'
    }
  });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// MongoDB connection URI
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/institute_erp';

// Ensure JWT_SECRET is set before starting server logic that might use it
if (!process.env.JWT_SECRET) {
  console.warn('⚠️ JWT_SECRET is not set. Using a default secret for development purposes.');
  process.env.JWT_SECRET = 'default_development_secret';
}

mongoose.connect(MONGODB_URI, {
  maxPoolSize: 50,
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  bufferCommands: false
})
  .then(async () => {
    console.log('✅ Connected to MongoDB Atlas with optimizations');
    console.log('📊 Connection pool size: 50');

    // Initialize Database Manager
    await DatabaseManager.initialize();
    console.log('✅ Database Manager initialized');

    console.log('🚀 Server ready for multi-tenant operations');

    // Start server only after successful DB connection and initialization
    server.listen(PORT, () => {
      console.log(`🌐 Server running on port ${PORT}`);
      console.log(`🏫 Multi-tenant school ERP system ready`);
      console.log(`🔌 Socket.IO server ready for real-time communication`);

      // Start temp folder cleanup task (runs every 30 seconds)
      startTempFolderCleanup();
    });
  })
  .catch((error) => {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1); // Exit if DB connection fails
  });


// Temp folder cleanup function
function cleanupTempFolder() {
  const tempDir = path.join(__dirname, 'uploads', 'temp');

  // Check if temp directory exists
  if (!fs.existsSync(tempDir)) {
    // --- HOSTING FIX: Create temp dir if it doesn't exist ---
    try {
      fs.mkdirSync(tempDir, { recursive: true });
      console.log('ℹ️ Created temp directory for uploads.');
    } catch (mkdirError) {
      console.error('❌ Failed to create temp directory:', mkdirError);
      return;
    }
    // --- END FIX ---
  }

  try {
    const files = fs.readdirSync(tempDir);

    if (files.length === 0) {
      // console.log('✅ Temp folder is already clean (0 files)');
      return;
    }

    let deletedCount = 0;
    let errorCount = 0;
    let skippedCount = 0;
    const now = Date.now();
    const fiveMinutesAgo = now - (5 * 60 * 1000); // 5 minutes in milliseconds

    files.forEach(file => {
      const filePath = path.join(tempDir, file);

      try {
        const stats = fs.statSync(filePath);

        // Only delete files, not directories
        if (stats.isFile()) {
          // Only delete files older than 5 minutes to avoid EPERM errors
          const fileAge = stats.mtimeMs;
          if (fileAge < fiveMinutesAgo) {
            try {
              // Try to release file handle before deletion (Windows compatibility)
              fs.closeSync(fs.openSync(filePath, 'r'));
            } catch (e) {
              // Ignore if file handle release fails
            }

            fs.unlinkSync(filePath);
            deletedCount++;
          } else {
            skippedCount++;
          }
        }
      } catch (err) {
        // Only log EPERM errors as warnings, not errors
        if (err.code === 'EPERM') {
          // File is still in use, skip it silently
          skippedCount++;
        } else {
          console.error(`❌ Error deleting ${file}:`, err.message);
          errorCount++;
        }
      }
    });

    if (deletedCount > 0 || errorCount > 0) {
      console.log(`🗑️ Temp cleanup: Deleted ${deletedCount} file(s), Skipped ${skippedCount} file(s), ${errorCount} error(s)`);
    }
  } catch (err) {
    console.error('❌ Error reading temp directory:', err.message);
  }
}

// Start periodic temp folder cleanup
function startTempFolderCleanup() {
  console.log('🗑️ Starting temp folder cleanup task (runs every 60 seconds)...');

  // Run immediately on startup
  cleanupTempFolder();

  //Then run every 60 seconds (less aggressive for Windows)
  setInterval(() => {
    cleanupTempFolder();
  }, 1000); // 60 seconds
}

// 404 handler - MUST come before error handler
app.use('*', (req, res, next) => {
  console.log('❌ 404 - Route not found:', req.originalUrl);
  // Always return JSON, never HTML
  res.status(404).json({
    success: false,
    message: 'Route not found',
    path: req.originalUrl,
    availableEndpoints: '/api/health, /api/auth, /api/users, /api/schools'
  });
});

// Global error handler - MUST come after 404 handler
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);

  // CORS error handling
  if (err.message && err.message.includes('CORS')) {
    return res.status(403).json({
      success: false,
      message: 'CORS policy error',
      error: 'Origin not allowed'
    });
  }

  // Always return JSON, never HTML
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.stack : 'Something went wrong'
  });
});

// Graceful shutdown handling
process.on('SIGINT', async () => {
  console.log('\n🔄 Gracefully shutting down...');
  try {
    await DatabaseManager.closeAllConnections();
    await mongoose.connection.close();
    console.log('✅ All connections closed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error during shutdown:', error);
    process.exit(1);
  }
});

// Note: server start moved to after successful DB connect
