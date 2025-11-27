//
// File: jayeshsardesai/erp/ERP-7a5c138ae65bf53237b3e294be93792d26fb324a/backend/controllers/exportImportController.js
//
// --- Imports ---
const User = require('../models/User');
const School = require('../models/School');
const { generateStudentPasswordFromDOB, generateRandomPassword } = require('../utils/passwordGenerator');
const csv = require('csv-parse');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const SchoolDatabaseManager = require('../utils/databaseManager');
const { generateSequentialUserId } = require('./userController');
const sharp = require('sharp');
const axios = require('axios');
const { uploadToCloudinary, deleteLocalFile, uploadBufferToCloudinary } = require('../config/cloudinary');

const parseCsv = promisify(csv.parse);

// --- Export Function (Enhanced) ---
exports.exportUsers = async (req, res) => {
  try {
    const { schoolCode } = req.params;
    const { role = 'student', format = 'csv' } = req.query; // Default role to student for now
    const upperSchoolCode = schoolCode.toUpperCase();

    const school = await School.findOne({ code: upperSchoolCode });
    if (!school) {
      return res.status(404).json({ message: 'School not found' });
    }

    // Connect to the school's database
    let connection;
    try {
      connection = await SchoolDatabaseManager.getSchoolConnection(upperSchoolCode);
      if (!connection) throw new Error('Database connection object invalid');
    } catch (connError) {
      console.error(`DB Connect Error for ${upperSchoolCode} in exportUsers: ${connError.message}`);
      return res.status(500).json({ success: false, message: 'Could not connect to school database' });
    }
    const db = connection.db;

    let users = [];
    let headers = [];
    const collectionName = `${role}s`; // 'students', 'teachers', or 'admins'

    // --- MODIFIED: Added 'admin' role support for export ---
    if (!['student', 'teacher', 'admin'].includes(role)) {
      return res.status(400).json({ message: 'Export currently only supports "student", "teacher", or "admin" roles.' });
    }

    try {
      // Find users, excluding sensitive fields like password
      users = await db.collection(collectionName).find({}, { projection: { password: 0, temporaryPassword: 0, passwordHistory: 0 } }).toArray();
    } catch (fetchError) {
      console.error(`Error fetching users from ${collectionName} for ${upperSchoolCode}:`, fetchError);
      return res.status(500).json({ message: `Error fetching ${role} data`, error: fetchError.message });
    }

    if (role === 'student') {
      headers = getStudentHeadersRobust();
    } else if (role === 'teacher') {
      headers = getTeacherHeadersSimplified();
    } else { // role === 'admin'
      headers = getAdminHeaders(); // <--- NEW: Get Admin Headers
    }


    if (users.length === 0) {
      if (format === 'excel') return res.json({ success: true, data: [], headers: headers, filename: `${upperSchoolCode}_${role}_users_empty.xlsx` });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${upperSchoolCode}_${role}_users_empty.csv"`);
      return res.send(headers.join(','));
    }

    if (format === 'excel' || format === 'json') {
      // For JSON/Excel, structure data slightly better if needed, potentially flattening details
      const formattedUsers = users.map(user => formatUserForExport(user, role));
      return res.json({
        success: true, count: users.length, data: formattedUsers,
        headers: headers, // Send headers for Excel generation on frontend
        filename: `${upperSchoolCode}_${role}_users_${new Date().toISOString().split('T')[0]}.${format === 'excel' ? 'xlsx' : 'json'}`
      });
    }

    const csvContent = generateCSV(users, role); // Pass role to generateCSV
    const filename = `${upperSchoolCode}_${role}_users_${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvContent);

  } catch (error) {
    console.error(`Error exporting users for ${req.params.schoolCode}:`, error);
    res.status(500).json({ message: 'Error exporting users', error: error.message });
  }
};


// ==================================================================
// IMPORT FUNCTION (MODIFIED TO INFER ROLE FROM CSV HEADERS)
// ==================================================================
exports.importUsers = async (req, res) => {
  const { schoolCode } = req.params;
  const file = req.file;
  const creatingUserId = req.user?._id;
  const upperSchoolCode = schoolCode.toUpperCase();

  // --- Initial Checks ---
  if (!file) { return res.status(400).json({ message: 'No file uploaded' }); }
  if (!creatingUserId) {
    // Attempt to delete temp file before sending error
    return res.status(401).json({ message: 'Unauthorized: User performing import not identified.' });
  }

  // --- Validate School ---
  let school;
  try {
    school = await School.findOne({ code: upperSchoolCode });
    if (!school) {
      throw new Error(`School with code ${upperSchoolCode} not found`);
    }
  } catch (schoolError) {
    console.error(`Error finding school ${upperSchoolCode}:`, schoolError);
    return res.status(500).json({ message: schoolError.message || 'Error verifying school.' });
  }

  // --- Get School DB Connection ---
  let connection;
  try {
    connection = await SchoolDatabaseManager.getSchoolConnection(upperSchoolCode);
    if (!connection) throw new Error('Database connection object invalid');
  } catch (connError) {
    console.error(`DB Connect Error for ${upperSchoolCode} in importUsers: ${connError.message}`);
    return res.status(500).json({ success: false, message: 'Could not connect to school database' });
  }
  const db = connection.db;

  // --- MODIFIED: Get Current Academic Year (from school_info) ---
  let currentAcademicYear = '2024-25'; // Default fallback
  try {
    // Find the school's main configuration document
    const schoolInfoDoc = await db.collection('school_info').findOne(); // <-- Find the one school_info doc

    // Use the path from your JSON: academicYear.currentYear
    if (schoolInfoDoc && schoolInfoDoc.academicYear && schoolInfoDoc.academicYear.currentYear) {
      currentAcademicYear = schoolInfoDoc.academicYear.currentYear;
      console.log(`Using current academic year from school_info: ${currentAcademicYear}`);
    } else {
      console.warn(`No 'academicYear.currentYear' found in school_info for ${upperSchoolCode}. Defaulting to '${currentAcademicYear}'.`);
    }
  } catch (yearError) {
    console.error(`Error fetching academic year from school_info for ${upperSchoolCode}:`, yearError.message);
  }
  // --- END OF MODIFICATION ---

  // --- CSV Header Mappings (Combined) ---
  const headerMappings = {
    // Basic Info (Common)
    'firstname': 'firstname', 'middlename': 'middlename', 'lastname': 'lastname',
    'email': 'email', 'phone': 'primaryphone', 'primaryphone': 'primaryphone',
    'dateofbirth': 'dateofbirth', 'dob': 'dateofbirth', 'birthdate': 'dateofbirth',
    'gender': 'gender',
    // Address Info (Common)
    'address': 'permanentstreet', 'permanentstreet': 'permanentstreet', 'permanentarea': 'permanentarea',
    'city': 'permanentcity', 'permanentcity': 'permanentcity', 'state': 'permanentstate', 'permanentstate': 'permanentstate',
    'pincode': 'permanentpincode', 'permanentpincode': 'permanentpincode',
    'country': 'permanentcountry', 'permanentcountry': 'permanentcountry', 'permanentlandmark': 'permanentlandmark',
    'sameaspermanent': 'sameaspermanent', 'currentstreet': 'currentstreet', 'currentcity': 'currentcity',
    'currentstate': 'currentstate', 'currentpincode': 'currentpincode', 'currentcountry': 'currentcountry',
    'currentarea': 'currentarea', 'currentlandmark': 'currentlandmark',
    // Status (Common)
    'status': 'isactive', 'isactive': 'isactive',
    // Identity (Common)
    'aadharnumber': 'aadharnumber', 'religion': 'religion',
    // Bank Details (Common)
    'bankname': 'bankname', 'accountnumber': 'bankaccountno', 'bankaccountno': 'bankaccountno',
    'ifscode': 'bankifsc', 'bankifsc': 'bankifsc',
    'profileimage': 'profileimage', // <--- ADDED: Profile Image (Common)

    // Student Specific
    'studentid': 'studentid', 'admissionnumber': 'admissionnumber', 'rollnumber': 'rollnumber',
    'class': 'currentclass', 'currentclass': 'currentclass', 'admissiontoclass': 'currentclass', 'admissiontoclass': 'currentclass', 'section': 'currentsection', 'currentsection': 'currentsection',
    'academicyear': 'academicyear', 'admissiondate': 'admissiondate',
    'fathername': 'fathername', 'mothername': 'mothername', 'guardianname': 'guardianname',
    'fatherphone': 'fatherphone', 'motherphone': 'motherphone', 'fatheremail': 'fatheremail', 'motheremail': 'motheremail',
    'caste': 'caste', 'category': 'category', 'disability': 'disability', 'isrtcandidate': 'isrtcandidate',
    'previousschool': 'previousschoolname', 'previousschoolname': 'previousschoolname',
    'transportmode': 'transportmode', 'busroute': 'busroute', 'pickuppoint': 'pickuppoint',
    'feecategory': 'feecategory', 'concessiontype': 'concessiontype', 'concessionpercentage': 'concessionpercentage',
    'medicalconditions': 'medicalconditions', 'allergies': 'allergies', 'specialneeds': 'specialneeds',
    'previousboard': 'previousboard', 'lastclass': 'lastclass', 'tcnumber': 'tcnumber',
    // 'profileimage': 'profileimage', <-- Already added to common
    'tcno': 'tcnumber', 'tc': 'tcnumber',
    // Enrollment synonyms
    'enrollmentno': 'admissionnumber', 'enrollmentnumber': 'admissionnumber',
    // Student caste certificate
    'studentcastecertificateno': 'studentcastecertno', 'studentcastecertno': 'studentcastecertno', 'studentcastecertificate': 'studentcastecertno',
    // Accept 'userid' header in templates (mapped to student id/admission slot)
    'userid': 'studentid', 'user id': 'studentid', 'userId': 'studentid',

    // Teacher Specific (Original complex fields)
    'secondaryphone': 'secondaryphone', 'whatsappnumber': 'whatsappnumber', 'pannumber': 'pannumber',
    'joiningdate': 'joiningdate', 'highestqualification': 'highestqualification', 'specialization': 'specialization',
    'totalexperience': 'totalexperience', 'subjects': 'subjects', 'classteacherof': 'classteacherof',
    'employeeid': 'employeeid', 'bloodgroup': 'bloodgroup', 'nationality': 'nationality',

    // Teacher Specific (Simplified template fields)
    'phonenumber': 'primaryphone', 'qualification': 'qualification', 'experience': 'experience(years)', 'experience(years)': 'experience(years)',
    'subjectstaught': 'subjectstaught', 'address': 'address',

    // Admin Specific <--- NEW: Admin Fields
    'admintype': 'admintype', 'adminlevel': 'admintype', 'designation': 'designation', 'department': 'department',
    'accountholdername': 'accountholdername', 'bankbranchname': 'bankbranchname',
    'permissionsusermanagement': 'permissions_usermanagement',
    'permissionsacademicmanagement': 'permissions_academicmanagement',
    'permissionsfeemanagement': 'permissions_feemanagement',
    'permissionsreportgeneration': 'permissions_reportgeneration',
    'permissionssystemsettings': 'permissions_systemsettings',
    'permissionsschoolsettings': 'permissions_schoolsettings',
    'permissionsdataexport': 'permissions_dataexport',
    'permissionsauditlogs': 'permissions_auditlogs',
    // Template variations
    'cityvillagetown': 'permanentcity', 'schooladmissiondate': 'admissiondate', 'bankifsccode': 'bankifsc', 'isrtecandidate': 'isrtcandidate',
  };

  // --- Parse CSV and INFER ROLE ---
  let csvData;
  let inferredRole = null;
  let firstRowKeys = new Set();

  try {
    console.log(`Parsing CSV file and inferring role...`);
    const fileContent = file.buffer;
    csvData = await parseCsv(fileContent, {
      columns: true, trim: true, skip_empty_lines: true, bom: true,
      on_record: (record, context) => {
        const normalizedRecord = {};
        const currentRecordKeys = new Set();

        for (const key in record) {
          const normalizedKey = key.toLowerCase()
            .replace('*', '')
            .split(' (')[0]
            .replace(/[^\w]/gi, '') // Remove non-alphanumeric
            .trim();
          const internalKey = headerMappings[normalizedKey];
          if (internalKey) {
            normalizedRecord[internalKey] = record[key];
            currentRecordKeys.add(internalKey);
          }
        }

        // --- Role Inference Logic (only on the first data row) ---
        if (context.lines === 2) { // Line 1 is header, Line 2 is first data row
          firstRowKeys = currentRecordKeys;
          console.log('First data row keys:', Array.from(firstRowKeys));

          // 1. Prioritize student check
          // Accept either: (class + section + fathername) OR (class + admissionNumber/enrollment) so templates
          // that use Enrollment No + Admission to Class (no section/father) are still recognized as students.
          const hasClass = firstRowKeys.has('currentclass');
          const hasSection = firstRowKeys.has('currentsection');
          const hasFather = firstRowKeys.has('fathername');
          const hasAdmissionNumber = firstRowKeys.has('admissionnumber') || firstRowKeys.has('studentid') || firstRowKeys.has('enrollmentnumber') || firstRowKeys.has('enrollmentno');
          if (hasClass && ((hasSection && hasFather) || hasAdmissionNumber)) {
            inferredRole = 'student';
          }
          // 2. Then check for teacher (original complex format)
          else if (firstRowKeys.has('joiningdate') && firstRowKeys.has('highestqualification') && firstRowKeys.has('totalexperience')) {
            inferredRole = 'teacher';
          }
          // 2b. Check for teacher (simplified template format)
          else if (firstRowKeys.has('qualification') && (firstRowKeys.has('phonenumber') || firstRowKeys.has('subjectstaught'))) {
            inferredRole = 'teacher';
          }
          // 3. Then check for admin <--- NEW: Admin Inference
          else if (firstRowKeys.has('joiningdate') && (firstRowKeys.has('admintype') || firstRowKeys.has('designation'))) {
            inferredRole = 'admin';
          }
          else {
            throw new Error("Could not infer user role (student/teacher/admin) from CSV columns. Ensure headers like 'currentclass'/'fathername' (for students) OR 'joiningdate'/'highestqualification' (for teachers) OR 'admintype'/'designation' (for admins) are present."); // <--- MODIFIED ERROR MESSAGE
          }
          console.log(`Inferred Role: ${inferredRole}`);
        }
        return normalizedRecord;
      }
    });
    console.log(`CSV Parsed. Found ${csvData.length} data rows.`);

    // If parsing finished but role couldn't be inferred (e.g., empty file after header)
    if (csvData.length > 0 && !inferredRole) {
      throw new Error("Could not infer user role from CSV. File might have issues or missing key columns after the header.");
    }
    if (csvData.length === 0) {
      console.warn("CSV contains no data rows.");
      // No need to infer role if no data
    }
  } catch (parseError) {
    // Clean up file before returning error
    console.error('CSV Parsing/Role Inference Error:', parseError);
    return res.status(400).json({ message: parseError.message || 'Failed to parse CSV file or infer role. Ensure valid CSV format and appropriate headers.', error: parseError.message });
  } finally {
    // Ensure file is deleted even if role inference failed mid-pars
  }

  // Handle case where file had only headers or was empty
  if (csvData.length === 0) {
    return res.status(400).json({ message: 'CSV file is empty or contains no data rows.' });
  }

  // --- Set collection based on inferred role ---
  const collectionName = `${inferredRole}s`;
  const userCollection = db.collection(collectionName);
  console.log(`Using database collection: ${collectionName}`);

  // --- Process Rows Serially ---
  const results = { success: [], errors: [], total: csvData.length };
  const usersToInsert = [];
  const processedEmails = new Set();

  let rowNumber = 1;
  console.log(`Starting row processing for inferred role: ${inferredRole}...`);
  for (const row of csvData) {
    rowNumber++;
    const userRole = inferredRole;
    const email = row['email']?.trim().toLowerCase();
    row.originalRowNumber = rowNumber;

    try {
      if (!email) throw new Error(`Email is required.`);
      if (processedEmails.has(email)) throw new Error(`Duplicate email '${email}' found within this CSV file.`);
      processedEmails.add(email);

      // --- DYNAMIC VALIDATION ---
      let validationErrors = [];
      if (userRole === 'student') {
        validationErrors = validateStudentRowRobust(row, rowNumber);

        // Additional validation: Check if class and section exist
        if (validationErrors.length === 0) {
          const currentClass = row['currentclass'];
          const currentSection = row['currentsection'];

          if (currentClass && currentSection) {
            const classesCollection = db.collection('classes');
            const classExists = await classesCollection.findOne({
              schoolId: school._id.toString(),
              className: currentClass,
              sections: currentSection,
              isActive: true
            });

            if (!classExists) {
              validationErrors.push({
                row: rowNumber,
                field: 'currentclass/currentsection',
                error: `Class "${currentClass}" with Section "${currentSection}" does not exist. Please add this class/section in SuperAdmin before importing students.`
              });
              console.warn(`⚠️ Row ${rowNumber}: Class ${currentClass} Section ${currentSection} not found. Skipping student.`);
            }
          }
        }
      } else if (userRole === 'teacher') { // inferredRole is 'teacher'
        // Use simplified validation if it's the new template format
        if (row['qualification'] && !row['highestqualification']) {
          validationErrors = validateTeacherRowSimplified(row, rowNumber);
        } else {
          validationErrors = validateTeacherRow(row, rowNumber);
        }
      } else if (userRole === 'admin') { // <--- NEW: Admin Validation
        validationErrors = validateAdminRow(row, rowNumber);
      }
      // -------------------------

      if (validationErrors.length > 0) {
        throw new Error(validationErrors.map(e => `${e.field}: ${e.error}`).join('; '));
      }

      // Check against the correct collection for existing email
      const existingUser = await userCollection.findOne({ email: email });
      if (existingUser) {
        throw new Error(`User already exists in ${collectionName} collection with this email: ${email}`);
      }

      // Store row data temporarily - will generate userId during bulk insert preparation
      usersToInsert.push({
        _tempRowData: row,
        _tempSchoolId: school._id,
        _tempSchoolCode: upperSchoolCode,
        _tempCreatingUserId: creatingUserId,
        _tempUserRole: userRole,
        _tempRowNumber: rowNumber,
        _tempEmail: email
      });

    } catch (error) {
      console.error(`❌ Error processing row ${rowNumber}: ${error.message}`);
      // Add stack trace for debugging if needed
      // console.error(error.stack);
      results.errors.push({ row: rowNumber, data: row, error: error.message || 'Unknown error processing row.' });
    }
  } // --- End of Loop ---
  console.log(`Row processing finished. ${usersToInsert.length} ${collectionName} prepared for insertion.`);

  // --- Generate UserIds and Create User Objects (ONLY for validated rows) ---
  const finalUsersToInsert = [];
  for (const tempData of usersToInsert) {
    try {
      // Generate userId ONLY now, after all validation passed
      const userId = await generateSequentialUserId(tempData._tempSchoolCode, tempData._tempUserRole);

      // Create actual user data object
      let userData;
      if (tempData._tempUserRole === 'student') {
        // --- MODIFIED: Pass currentAcademicYear ---
        userData = await createStudentFromRowRobust(
          tempData._tempRowData,
          tempData._tempSchoolId,
          userId,
          tempData._tempSchoolCode,
          tempData._tempCreatingUserId,
          currentAcademicYear // <-- PASSING THE VARIABLE
        );
      } else if (tempData._tempUserRole === 'teacher') {
        userData = await createTeacherFromRow(
          tempData._tempRowData,
          tempData._tempSchoolId,
          userId,
          tempData._tempSchoolCode,
          tempData._tempCreatingUserId
        );
      } else if (tempData._tempUserRole === 'admin') { // <--- NEW: Admin Creation
        userData = await createAdminFromRow(
          tempData._tempRowData,
          tempData._tempSchoolId,
          userId,
          tempData._tempSchoolCode,
          tempData._tempCreatingUserId
        );
      }
      // --- END OF MODIFICATION ---

      finalUsersToInsert.push(userData);
      results.success.push({
        row: tempData._tempRowNumber,
        userId: userData.userId,
        email: userData.email,
        name: userData.name.displayName,
        password: userData.temporaryPassword
      });
    } catch (error) {
      console.error(`❌ Error creating user object for row ${tempData._tempRowNumber}:`, error.message);
      results.errors.push({
        row: tempData._tempRowNumber,
        data: tempData._tempRowData,
        error: `Failed to create user: ${error.message}`
      });
    }
  }
  console.log(`User objects created. ${finalUsersToInsert.length} ready for bulk insert.`);

  // --- Perform Bulk Insert ---
  let insertedCount = 0;
  if (finalUsersToInsert.length > 0) {
    console.log(`Attempting to bulk insert ${finalUsersToInsert.length} processed users into ${collectionName}...`);
    try {
      const insertResult = await userCollection.insertMany(finalUsersToInsert, { ordered: false });
      insertedCount = insertResult.insertedCount;
      console.log(`✅ Bulk insert attempted for ${upperSchoolCode}. Acknowledged inserts: ${insertedCount}.`);
    } catch (bulkError) {
      console.error(`Bulk insert operation error for ${upperSchoolCode}:`, bulkError);
      results.errors.push({
        row: 'N/A', // Error applies to the bulk operation, not a specific CSV row
        error: `Bulk insert failed: ${bulkError.message || 'Unknown bulk error'}. Some valid rows might not have been inserted. Check server logs and DB indexes.`
      });
      // Adjust counts based on bulk write errors if available
      insertedCount = bulkError.result?.nInserted || bulkError.insertedCount || 0;
      if (bulkError.writeErrors) {
        console.error("Bulk write errors encountered:", bulkError.writeErrors.length);
        // Identify which successfully processed rows failed during insert
        const failedEmails = new Set(bulkError.writeErrors.map(err => err.op?.email).filter(Boolean));
        results.success = results.success.filter(s => !failedEmails.has(s.email));

        // Add specific errors from bulk operation to the errors list
        bulkError.writeErrors.forEach(err => {
          const failedEmail = err.op?.email;
          const originalRow = csvData.find(r => r.email?.toLowerCase() === failedEmail); // Find original row data if possible
          results.errors.push({
            row: originalRow?.originalRowNumber || `N/A (Index ${err.index})`,
            error: `Insert Error: ${err.errmsg || 'Unknown insert error'}`,
            data: originalRow // Include original data for context
          });
        });
        // Update insertedCount to reflect actual successes reported by bulk result BEFORE write errors were handled
        insertedCount = bulkError.result?.nInserted || 0; // Use nInserted if available, otherwise assume 0 for safety
      } else {
        // If a general bulk error occurred without writeErrors, assume all failed
        insertedCount = 0;
        results.success = []; // Clear success data as we can't be sure which ones failed
      }
      console.log(`Adjusted inserted count after handling bulk errors: ${insertedCount}`);
    }
  } else {
    console.warn(`⚠️ Bulk import: No valid users to insert for ${upperSchoolCode}. Check processing errors.`);
  }
  // --- END BULK INSERT ---

  // --- Final Response ---
  // Recalculate based on final state AFTER bulk insert attempts
  const finalSuccessCount = results.success.length; // Rows that passed validation AND didn't fail bulk insert explicitly
  const finalErrorCount = results.errors.length;   // Validation errors + Bulk insert errors

  let inferredRoleName = inferredRole || 'user'; // Fallback
  let finalMessage = `Import process completed for ${inferredRoleName}s. Total CSV rows (excluding header): ${results.total}.`;

  // Message logic based on validation and insertion results
  if (results.total === 0) {
    finalMessage = 'Import process completed. The CSV file contained no data rows.';
  } else if (finalUsersToInsert.length === 0 && finalErrorCount > 0) {
    // All rows failed validation
    finalMessage += ` Rows successfully processed: 0. Rows with validation errors: ${finalErrorCount}. No ${inferredRoleName}s were inserted. Please review the errors.`;
  } else if (finalUsersToInsert.length > 0) {
    // Some rows were prepared for insert
    finalMessage += ` Rows prepared for insert: ${finalUsersToInsert.length}. Rows with validation errors: ${results.errors.filter(e => e.row !== 'N/A').length}.`; // Count only validation errors here
    finalMessage += ` Actual documents inserted: ${insertedCount}.`;
    if (insertedCount < finalUsersToInsert.length) {
      const bulkInsertFailures = finalUsersToInsert.length - insertedCount;
      finalMessage += ` ${bulkInsertFailures} prepared rows failed during bulk insert (e.g., duplicate email/ID). Check errors list (marked 'N/A' or 'Insert Error').`;
    } else if (finalErrorCount > 0) {
      finalMessage += ` Some initial rows failed validation (check errors list).`;
    }
  }

  // Overall success means no validation errors AND all prepared rows were inserted successfully.
  const overallSuccess = results.errors.filter(e => e.row !== 'N/A').length === 0 && (finalUsersToInsert.length === 0 || insertedCount === finalUsersToInsert.length);


  res.status(overallSuccess && results.total > 0 ? 201 : (finalErrorCount > 0 || insertedCount < finalUsersToInsert.length ? 400 : 200)).json({
    success: overallSuccess,
    message: finalMessage,
    results: {
      successData: results.success, // Final list that *should* have been inserted (minus bulk errors)
      errors: results.errors,       // Combined validation and bulk errors
      totalRows: results.total,
      insertedCount: insertedCount    // Actual DB inserts
    }
  });
};
// ==================================================================
// END: IMPORT FUNCTION
// ==================================================================


// Generate template for import
exports.generateTemplate = async (req, res) => {
  // (Keep this function exactly as it was in the previous 'role-aware' version)
  try {
    const { schoolCode } = req.params;
    const { role } = req.query;

    if (!role) { return res.status(400).json({ message: 'Role query parameter is required (e.g., ?role=student).' }); }

    // --- MODIFIED: Added 'admin' role support for template generation ---
    const supportedRoles = ['student', 'teacher', 'admin'];
    if (!supportedRoles.includes(role.toLowerCase())) {
      return res.status(400).json({ message: `Template generation currently only supported for roles: student, teacher, admin` });
    }

    let templateHeaders;
    if (role.toLowerCase() === 'student') {
      templateHeaders = getStudentHeadersRobust();
    } else if (role.toLowerCase() === 'teacher') {
      templateHeaders = getTeacherHeadersSimplified();
    } else { // role.toLowerCase() === 'admin'
      templateHeaders = getAdminHeaders(); // <--- NEW: Get Admin Headers
    }

    const filename = `${schoolCode.toUpperCase()}_${role}_import_template_${new Date().toISOString().split('T')[0]}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(templateHeaders.join(','));

  } catch (error) {
    console.error('Error generating template:', error);
    res.status(500).json({ message: 'Error generating template', error: error.message });
  }
};

// ==================================================================
// HELPER FUNCTIONS
// ==================================================================
// --- Profile Picture Upload Helper with Cloudinary ---
// REPLACED FUNCTION
// REPLACE THE ENTIRE 'copyProfilePicture' FUNCTION WITH THIS
// REPLACE the old function with this
async function copyProfilePicture(sourcePath, userId, schoolCode) {
  console.log(`🔍 copyProfilePicture called with: sourcePath="${sourcePath}", userId="${userId}", schoolCode="${schoolCode}"`);

  if (!sourcePath || String(sourcePath).trim() === '') {
    console.warn(`Empty profile image path provided. Skipping.`);
    return '';
  }

  try {
    let imageBuffer;

    // Clean the source path - remove leading ? or other unwanted characters
    let cleanSourcePath = sourcePath.trim();
    if (cleanSourcePath.startsWith('?')) {
      cleanSourcePath = cleanSourcePath.substring(1);
      console.log(`🧹 Cleaned path: "${sourcePath}" -> "${cleanSourcePath}"`);
    }

    // Check if it's a URL or local file path
    if (cleanSourcePath.startsWith('http://') || cleanSourcePath.startsWith('https://')) {
      // Handle URL - download the image
      let downloadUrl = cleanSourcePath;

      // Convert Google Drive sharing links to direct download links
      if (cleanSourcePath.includes('drive.google.com')) {
        console.log(`🔄 Converting Google Drive sharing link to direct download URL`);

        // Extract file ID from different Google Drive URL formats
        let fileId = null;

        // Format 1: https://drive.google.com/file/d/FILE_ID/view?usp=sharing
        const match1 = cleanSourcePath.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
        if (match1) {
          fileId = match1[1];
        }

        // Format 2: https://drive.google.com/open?id=FILE_ID
        const match2 = cleanSourcePath.match(/[?&]id=([a-zA-Z0-9_-]+)/);
        if (match2) {
          fileId = match2[1];
        }

        if (fileId) {
          downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
          console.log(`✅ Converted to direct download URL: ${downloadUrl}`);
        } else {
          console.warn(`⚠️ Could not extract file ID from Google Drive URL: ${cleanSourcePath}`);
          console.warn(`💡 Tip: Make sure the Google Drive file is publicly accessible`);
        }
      }

      console.log(`📸 Downloading image from URL: ${downloadUrl}`);
      const response = await axios.get(downloadUrl, {
        responseType: 'arraybuffer',
        timeout: 30000, // 30 second timeout
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      imageBuffer = Buffer.from(response.data);
      console.log(`✅ Downloaded ${imageBuffer.length} bytes from URL`);
    } else {
      // Handle local file path - but check if we're in production/cloud environment
      const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER;

      if (isProduction) {
        console.warn(`⚠️ Local file path provided in production environment: ${cleanSourcePath}`);
        console.warn(`⚠️ Skipping image upload - local paths not accessible in cloud deployment`);
        console.warn(`💡 Tip: Use URLs instead of local paths for cloud deployment`);
        console.warn(`💡 Alternative: Upload images to a public URL first, then use those URLs in CSV`);
        console.warn(`💡 Example: Upload to imgur, Google Drive (public), or your own server`);
        return ''; // Skip image upload in production for local paths
      }

      console.log(`📁 Reading image from local path: ${cleanSourcePath}`);

      // Check if file exists
      if (!fs.existsSync(cleanSourcePath)) {
        console.error(`❌ Local image file not found: ${cleanSourcePath}`);
        console.error(`❌ Original path was: ${sourcePath}`);
        throw new Error(`Local image file not found: ${cleanSourcePath}`);
      }

      // Check if it's actually a file (not a directory)
      const stats = fs.statSync(cleanSourcePath);
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${cleanSourcePath}`);
      }

      // Read the local file
      imageBuffer = fs.readFileSync(cleanSourcePath);
      console.log(`✅ Read ${imageBuffer.length} bytes from local file`);

      // Validate that we have a valid image buffer
      if (!imageBuffer || imageBuffer.length === 0) {
        throw new Error(`Empty or invalid image file: ${cleanSourcePath}`);
      }
    }

    console.log('🔄 Compressing image with Sharp...');
    // Compress the buffer in memory
    const compressedImageBuffer = await sharp(imageBuffer)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 }) // Slightly higher quality for profile images
      .toBuffer();

    console.log(`✅ Compressed image in memory: ${(compressedImageBuffer.length / 1024).toFixed(2)}KB`);

    // Validate Cloudinary configuration
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      throw new Error('Cloudinary configuration missing. Please check environment variables.');
    }

    // Upload the compressed buffer to Cloudinary
    const timestamp = Date.now();
    const cloudinaryFolder = `profiles/${schoolCode.toUpperCase()}`;
    const publicId = `${userId}_${timestamp}`;

    console.log(`☁️ Uploading to Cloudinary: ${cloudinaryFolder}/${publicId}`);
    const uploadResult = await uploadBufferToCloudinary(
      compressedImageBuffer,
      cloudinaryFolder,
      publicId
    );

    if (!uploadResult || !uploadResult.secure_url) {
      throw new Error('Cloudinary upload failed - no secure_url returned');
    }

    console.log(`✅ Profile image uploaded successfully: ${uploadResult.secure_url}`);
    console.log(`🔍 DEBUG: Upload result object:`, JSON.stringify(uploadResult, null, 2));
    return uploadResult.secure_url;

  } catch (error) {
    console.error(`❌ Error processing profile picture from ${sourcePath}:`, error.message);
    console.error(`❌ Error stack:`, error.stack);
    console.error(`❌ Full error details:`, error);

    // Provide more specific error messages
    if (error.message.includes('ENOENT')) {
      console.error(`❌ File not found error - check if the path exists and is accessible`);
    } else if (error.message.includes('Cloudinary')) {
      console.error(`❌ Cloudinary error - check API credentials and network connection`);
    } else if (error.message.includes('Sharp')) {
      console.error(`❌ Image processing error - file might be corrupted or not a valid image`);
    }

    return ''; // Return empty string on failure
  }
}
// --- Date Parser Helper ---
function parseFlexibleDate(dateString, fieldName = 'Date') {
  // (Keep this function exactly as it was in the previous 'role-aware' version)
  if (!dateString || String(dateString).trim() === '') return null;
  try {
    let parsedDate;
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateString)) { // YYYY-MM-DD
      const [year, month, day] = dateString.split('-').map(Number);
      if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) throw new Error('Invalid YYYY-MM-DD components.');
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      if (day > daysInMonth) throw new Error(`Day ${day} invalid for month ${month} in year ${year}.`);
      parsedDate = new Date(Date.UTC(year, month - 1, day));
    } else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(dateString)) { // DD/MM/YYYY
      const [day, month, year] = dateString.split('/').map(Number);
      if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) throw new Error('Invalid DD/MM/YYYY components.');
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      if (day > daysInMonth) throw new Error(`Day ${day} invalid for month ${month} in year ${year}.`);
      parsedDate = new Date(Date.UTC(year, month - 1, day));
    } else if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(dateString)) { // DD-MM-YYYY
      const [day, month, year] = dateString.split('-').map(Number);
      if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) throw new Error('Invalid DD-MM-YYYY components.');
      const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
      if (day > daysInMonth) throw new Error(`Day ${day} invalid for month ${month} in year ${year}.`);
      parsedDate = new Date(Date.UTC(year, month - 1, day));
    } else { // Fallback
      parsedDate = new Date(dateString);
      if (isNaN(parsedDate.getTime())) throw new Error('Unrecognized date format.');
      const year = parsedDate.getFullYear();
      if (year < 1900 || year > 2100) throw new Error('Parsed year out of reasonable range.');
      parsedDate = new Date(Date.UTC(parsedDate.getFullYear(), parsedDate.getMonth(), parsedDate.getDate()));
    }
    if (isNaN(parsedDate.getTime())) throw new Error('Resulting date is invalid.');
    return parsedDate;
  } catch (e) {
    console.error(`Invalid ${fieldName} '${dateString}'. ${e.message}`);
    throw new Error(`Invalid ${fieldName} format '${dateString}'. Use YYYY-MM-DD, DD/MM/YYYY, or DD-MM-YYYY.`);
  }
}

// --- Define Headers (Admin) <--- NEW FUNCTION
function getAdminHeaders() {
  return [
    'userId', 'firstName', 'middleName', 'lastName', 'email', 'primaryPhone',
    'secondaryPhone', 'whatsappNumber', 'dateOfBirth', 'gender',
    'permanentStreet', 'permanentArea', 'permanentCity', 'permanentState', 'permanentPincode', 'permanentCountry', 'permanentLandmark',
    'sameAsPermanent', 'currentStreet', 'currentArea', 'currentCity', 'currentState', 'currentPincode', 'currentCountry', 'currentLandmark',
    'aadharNumber', 'panNumber', 'joiningDate',
    'employeeId', 'adminType', 'designation', 'department',
    'permissions_userManagement', 'permissions_academicManagement', 'permissions_feeManagement', 'permissions_reportGeneration',
    'permissions_systemSettings', 'permissions_schoolSettings', 'permissions_dataExport', 'permissions_auditLogs',
    'bankName', 'accountNumber', 'bankIFSC', 'accountHolderName', 'bankBranchName',
    'bloodGroup', 'nationality', 'religion', 'isActive', 'profileImage'
  ];
}

// --- Define Headers (Teacher) ---
function getTeacherHeaders() {
  return [
    'userId', 'firstName', 'middleName', 'lastName', 'email', 'primaryPhone',
    'secondaryPhone', 'whatsappNumber', 'dateOfBirth', 'gender',
    'permanentStreet', 'permanentArea', 'permanentCity', 'permanentState', 'permanentPincode', 'permanentCountry', 'permanentLandmark',
    'sameAsPermanent', 'currentStreet', 'currentArea', 'currentCity', 'currentState', 'currentPincode', 'currentCountry', 'currentLandmark',
    'aadharNumber', 'panNumber', 'joiningDate', 'highestQualification',
    'specialization', 'totalExperience', 'subjects', 'classTeacherOf',
    'employeeId', 'bankName', 'bankAccountNo', 'bankIFSC',
    'bloodGroup', 'nationality', 'religion', 'isActive', 'profileImage'
  ];
}

function getTeacherHeadersSimplified() {
  return [
    'First Name',
    'Last Name',
    'Email',
    'Date of Birth',
    'Gender',
    'Qualification',
    'Experience (Years)',
    'Subjects Taught',
    'Employee ID',
    'Address',
    'Profile Image'
  ];
}

function getStudentHeadersRobust() {
  return [
    'User ID',
    'First Name',
    'Last Name',
    'Email',
    'Phone Number',
    'Date of Birth',
    'Gender',
    'Blood Group',
    'Enrollment No',
    'TC No',
    'Admission to Class',
    'Section',
    'Academic Year',
    'Is RTE Candidate',
    'Father Name',
    'Permanent Street',
    'City/Village/Town',
    'Pin Code',
    'Aadhar Number',
    'School Admission Date',
    'Address',
    'Bank Name',
    'Bank Account No',
    'Bank IFSC Code',
    'Nationality',
    'Student Caste Certificate No',
    'Profile Image'
  ];
}

// --- NEW: Simplified Teacher Validation (matching simplified template) ---
// REPLACE your old validateTeacherRowSimplified function with this one:

function validateTeacherRowSimplified(normalizedRow, rowNumber) {
  const errors = [];

  // Updated required keys to include new headers (phone removed from template)
  const requiredKeys = [
    'firstname', 'lastname', 'email',
    'dateofbirth', 'gender', 'qualification'
  ];

  requiredKeys.forEach(key => {
    if (!normalizedRow.hasOwnProperty(key) || normalizedRow[key] === undefined || normalizedRow[key] === null || String(normalizedRow[key]).trim() === '') {
      errors.push({ row: rowNumber, error: `is required`, field: key });
    }
  });

  // Field validations
  if (normalizedRow['email'] && !/\S+@\S+\.\S+/.test(normalizedRow['email'])) {
    errors.push({ row: rowNumber, error: `Invalid format`, field: 'email' });
  }

  const genderVal = normalizedRow['gender']?.toLowerCase();
  if (genderVal && genderVal.trim() !== '' && !['male', 'female', 'other'].includes(genderVal)) {
    errors.push({ row: rowNumber, error: `Invalid value (must be 'male', 'female', 'other')`, field: 'gender' });
  }

  const phone = normalizedRow['primaryphone'];
  if (phone && phone.trim() !== '' && !/^\d{7,15}$/.test(phone.replace(/\D/g, ''))) {
    errors.push({ row: rowNumber, error: `Invalid format (must be 7-15 digits)`, field: 'primaryphone' });
  }

  if (normalizedRow['dateofbirth']) {
    try {
      parseFlexibleDate(normalizedRow['dateofbirth'], 'Date of Birth');
    } catch (e) {
      errors.push({ row: rowNumber, error: e.message, field: 'dateofbirth' });
    }
  }

  // Validate experience (years) - optional field
  const exp = normalizedRow['experience(years)'];
  if (exp && exp.trim() !== '' && isNaN(Number(exp))) {
    errors.push({ row: rowNumber, error: `must be a number`, field: 'experience(years)' });
  }

  return errors;
}

// --- Helper to create Teacher Data Object ---
async function createTeacherFromRow(normalizedRow, schoolIdAsObjectId, userId, schoolCode, creatingUserIdAsObjectId) {
  const email = normalizedRow['email'];
  const finalDateOfBirth = parseFlexibleDate(normalizedRow['dateofbirth'], 'Date of Birth');
  if (!finalDateOfBirth) throw new Error('Date of Birth is required and could not be parsed.');
  const finalJoiningDate = parseFlexibleDate(normalizedRow['joiningdate'], 'Joining Date') || new Date(); // Default to current date if not provided
  let temporaryPassword = generateRandomPassword(8);
  const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
  let gender = normalizedRow['gender']?.toLowerCase();
  if (!['male', 'female', 'other'].includes(gender)) gender = 'other';
  const isActiveValue = normalizedRow['isactive']?.toLowerCase();
  let isActive = true;
  if (isActiveValue === 'false' || isActiveValue === 'inactive' || isActiveValue === 'no' || isActiveValue === '0') {
    isActive = false;
  }
  const sameAsPermanent = normalizedRow['sameaspermanent']?.toLowerCase() !== 'false';
  let permanentPincode = normalizedRow['permanentpincode'] || '';
  if (permanentPincode && !/^\d{6}$/.test(permanentPincode)) permanentPincode = '';
  let currentPincode = normalizedRow['currentpincode'] || '';
  if (currentPincode && !/^\d{6}$/.test(currentPincode)) currentPincode = '';

  let totalExperience = 0;
  const experienceCandidates = [
    normalizedRow['totalexperience'],
    normalizedRow['experience(years)'],
    normalizedRow['experienceyears'],
    normalizedRow['experience']
  ];
  for (const cand of experienceCandidates) {
    if (cand !== undefined && cand !== null && String(cand).trim() !== '') {
      const parsed = parseInt(String(cand).replace(/[^0-9-]/g, ''), 10);
      if (!isNaN(parsed)) { totalExperience = parsed; break; }
    }
  }
  const firstName = normalizedRow['firstname'] || '';
  const lastName = normalizedRow['lastname'] || '';

  // Handle profile image if provided
  let profileImagePath = '';
  if (normalizedRow['profileimage']) {
    profileImagePath = await copyProfilePicture(normalizedRow['profileimage'], userId, schoolCode);
    console.log(`🔍 DEBUG: Teacher profile image path returned: ${profileImagePath}`);
  }

  // --- START OF SUBJECTS FIX ---
  // 1. Get the raw string from either new template ('subjectstaught') or old ('subjects')
  const subjectsString = normalizedRow['subjectstaught'] || normalizedRow['subjects'] || '';

  // 2. Split the string by comma, trim, filter empty, and map to the schema structure
  const subjectsArray = (typeof subjectsString === 'string')
    ? subjectsString.split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(subjectName => ({
        subjectName: subjectName,
        subjectCode: '',
        classes: [],
        isPrimary: false
      }))
    : [];
  // --- END OF SUBJECTS FIX ---

  // Build teacherDetails using the newer schema (teacherDetails)
  const teacherDetails = {
    subjects: subjectsArray, // <-- Use the corrected array here
    classes: [],
    employeeId: (normalizedRow['employeeid'] && String(normalizedRow['employeeid']).trim()) || userId,
    joinDate: finalJoiningDate,
    qualification: (normalizedRow['highestqualification'] || normalizedRow['qualification'] || '').trim(),
    experience: totalExperience,
    designation: (normalizedRow['designation'] || '').trim(),
    department: (normalizedRow['department'] || '').trim(),
  };

  // If there's a simplified 'Address' column (single-cell)
  let permanentStreetVal = normalizedRow['permanentstreet'] || '';
  let permanentAreaVal = normalizedRow['permanentarea'] || '';
  let permanentCityVal = normalizedRow['permanentcity'] || '';
  let permanentStateVal = normalizedRow['permanentstate'] || '';
  let permanentPincodeVal = normalizedRow['permanentpincode'] || '';

  if (normalizedRow['address'] && String(normalizedRow['address']).trim() !== '') {
    const addr = String(normalizedRow['address']).trim();
    const parts = addr.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length === 1) {
      permanentStreetVal = permanentStreetVal || parts[0];
    } else if (parts.length === 2) {
      permanentAreaVal = permanentAreaVal || parts[0];
      permanentCityVal = permanentCityVal || parts[1];
    } else if (parts.length === 3) {
      permanentAreaVal = permanentAreaVal || parts[0];
      permanentCityVal = permanentCityVal || parts[1];
      permanentStateVal = permanentStateVal || parts[2];
    } else if (parts.length >= 4) {
      permanentStreetVal = permanentStreetVal || parts[0];
      permanentAreaVal = permanentAreaVal || parts[1];
      permanentCityVal = permanentCityVal || parts[2];
      permanentStateVal = permanentStateVal || parts[3];
      if (parts[4]) permanentPincodeVal = permanentPincodeVal || parts[4].replace(/[^0-9]/g, '');
    }
  }
  const newTeacher = {
    _id: new ObjectId(),
    userId,
    schoolCode: schoolCode.toUpperCase(),
    schoolId: schoolIdAsObjectId,
    name: {
      firstName,
      middleName: normalizedRow['middlename'] || '',
      lastName,
      displayName: `${firstName} ${lastName}`.trim()
    },
    email: email,
    password: hashedPassword,
    temporaryPassword: temporaryPassword,
    passwordChangeRequired: true,
    role: 'teacher',
    contact: {
      primaryPhone: normalizedRow['primaryphone'] || '',
      secondaryPhone: normalizedRow['secondaryphone'] || '',
      whatsappNumber: normalizedRow['whatsappnumber'] || '',
    },
    address: {
      permanent: {
        street: permanentStreetVal || '',
        area: permanentAreaVal || '',
        city: permanentCityVal || '',
        state: permanentStateVal || '',
        country: normalizedRow['permanentcountry'] || 'India',
        pincode: permanentPincodeVal || permanentPincode || '',
        landmark: normalizedRow['permanentlandmark'] || ''
      },
      current: sameAsPermanent ? undefined : {
        street: normalizedRow['currentstreet'] || '',
        area: normalizedRow['currentarea'] || '',
        city: normalizedRow['currentcity'] || '',
        state: normalizedRow['currentstate'] || '',
        country: normalizedRow['currentcountry'] || 'India',
        pincode: currentPincode || '',
        landmark: normalizedRow['currentlandmark'] || ''
      },
      sameAsPermanent: sameAsPermanent
    },
    identity: {
      aadharNumber: normalizedRow['aadharnumber'] || '',
      panNumber: normalizedRow['pannumber'] || ''
    },
    profileImage: profileImagePath,
    isActive: isActive,
    createdAt: new Date(),
    updatedAt: new Date(),
    schoolAccess: {
      joinedDate: finalJoiningDate,
      assignedBy: creatingUserIdAsObjectId,
      status: 'active',
      accessLevel: 'full'
    },
    auditTrail: {
      createdBy: creatingUserIdAsObjectId,
      createdAt: new Date()
    },

    teacherDetails: teacherDetails, // <-- Corrected subjects are in here

    // This flat 'personal' object is used for backward compatibility
    personal: {
      dateOfBirth: finalDateOfBirth,
      gender: gender,
      bloodGroup: normalizedRow['bloodgroup']?.trim() || '',
      nationality: normalizedRow['nationality']?.trim() || 'Indian',
      religion: normalizedRow['religion']?.trim() || '',
      religionOther: '',
      caste: normalizedRow['caste']?.trim() || '',
      casteOther: '',
      category: normalizedRow['category']?.trim() || '',
      categoryOther: '',
      motherTongue: normalizedRow['mothertongue']?.trim() || '',
      motherTongueOther: '',
      aadhaar: normalizedRow['aadharnumber']?.trim() || '',
      pan: normalizedRow['pannumber']?.trim() || '',
      disability: normalizedRow['disability'] || 'Not Applicable',
      disabilityOther: ''
    },
    family: {
      father: {
        name: normalizedRow['fathername']?.trim() || '',
        occupation: normalizedRow['fatheroccupation']?.trim() || ''
      },
      mother: {
        name: normalizedRow['mothername']?.trim() || '',
        occupation: normalizedRow['motheroccupation']?.trim() || ''
      },
      spouse: {
        name: normalizedRow['spousename']?.trim() || '',
        occupation: normalizedRow['spouseoccupation']?.trim() || ''
      }
    }
  };
  return newTeacher;
}

function validateStudentRowRobust(normalizedRow, rowNumber) {
  const errors = [];

  // 'aadharnumber' is optional, so it's removed from requiredKeys
  const requiredKeys = [
    'firstname', 'lastname', 'email', 'primaryphone', 'dateofbirth', 'gender',
    'currentclass', 'currentsection', 'admissionnumber', 'tcnumber',
    'studentcastecertno', 'admissiondate',
    'bankname', 'bankaccountno', 'bankifsc', 'nationality',
    'permanentstreet', 'permanentcity', 'permanentpincode'
  ];

  requiredKeys.forEach(key => {
    if (!normalizedRow.hasOwnProperty(key) || normalizedRow[key] === undefined || normalizedRow[key] === null || String(normalizedRow[key]).trim() === '') {
      errors.push({ row: rowNumber, error: `is required`, field: key });
    }
  });

  // Basic format validations
  if (normalizedRow['email'] && !/\S+@\S+\.\S+/.test(normalizedRow['email'])) { errors.push({ row: rowNumber, error: `Invalid format`, field: 'email' }); }
  const pincode = normalizedRow['permanentpincode']; if (pincode && pincode.trim() !== '' && !/^\d{6}$/.test(pincode)) { errors.push({ row: rowNumber, error: `Invalid format (must be 6 digits if provided)`, field: 'permanentpincode' }); }
  const currentPincode = normalizedRow['currentpincode']; if (currentPincode && currentPincode.trim() !== '' && !/^\d{6}$/.test(currentPincode)) { errors.push({ row: rowNumber, error: `Invalid format (must be 6 digits if provided)`, field: 'currentpincode' }); }
  const gender = normalizedRow['gender']?.toLowerCase(); if (gender && gender.trim() !== '' && !['male', 'female', 'other'].includes(gender)) { errors.push({ row: rowNumber, error: `Invalid value (must be 'male', 'female', or 'other' if provided)`, field: 'gender' }); }
  const phone = normalizedRow['primaryphone']; if (phone && phone.trim() !== '' && !/^\d{7,15}$/.test(phone.replace(/\D/g, ''))) { errors.push({ row: rowNumber, error: `Invalid format (must be 7-15 digits if provided)`, field: 'primaryphone' }); }

  // --- MODIFIED AADHAAR VALIDATION (HANDLES SCIENTIFIC NOTATION) ---
  if (normalizedRow['aadharnumber'] && String(normalizedRow['aadharnumber']).trim() !== '') {
    let aadhaar = (normalizedRow['aadharnumber'] || '').toString().trim();
    if (/e\+/i.test(aadhaar)) { // Check for scientific notation like 2.345E+11
      try {
        aadhaar = BigInt(Number(aadhaar)).toString();
      } catch (e) {
        aadhaar = ''; // Failed conversion
      }
    } else { // Not scientific, just clean non-digits
      aadhaar = aadhaar.replace(/\D/g, '');
    }

    if (aadhaar.length !== 12) {
      errors.push({ row: rowNumber, error: `Invalid Aadhaar (must be 12 digits). Value received: "${normalizedRow['aadharnumber']}"`, field: 'aadharnumber' });
    }
  }
  // --- END OF MODIFICATION ---

  // IFSC validation
  const ifsc = (normalizedRow['bankifsc'] || '').toString().trim();
  if (ifsc && !/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(ifsc)) { errors.push({ row: rowNumber, error: `Invalid IFSC format`, field: 'bankifsc' }); }

  const rte = normalizedRow['isrtcandidate']?.toLowerCase(); if (rte && rte.trim() !== '' && !['yes', 'no'].includes(rte)) { errors.push({ row: rowNumber, error: `Invalid value (must be 'Yes' or 'No' if provided)`, field: 'isrtcandidate' }); }
  if (normalizedRow['dateofbirth']) { try { parseFlexibleDate(normalizedRow['dateofbirth'], 'Date of Birth'); } catch (e) { errors.push({ row: rowNumber, error: e.message, field: 'dateofbirth' }); } }
  if (normalizedRow['admissiondate']) { try { parseFlexibleDate(normalizedRow['admissiondate'], 'Admission Date'); } catch (e) { errors.push({ row: rowNumber, error: e.message, field: 'admissiondate' }); } }
  const concPerc = normalizedRow['concessionpercentage']; if (concPerc && (isNaN(Number(concPerc)) || Number(concPerc) < 0 || Number(concPerc) > 100)) { errors.push({ row: rowNumber, error: `must be a number between 0 and 100`, field: 'concessionpercentage' }); }
  return errors;
}

// --- Robust Helper to Create Student Data Object ---
// REPLACE your old function with this new version
// REPLACE your entire createStudentFromRowRobust function with this

// REPLACE your entire createStudentFromRowRobust function with this one:

// REPLACE your entire createStudentFromRowRobust function with this one:

async function createStudentFromRowRobust(normalizedRow, schoolIdAsObjectId, userId, schoolCode, creatingUserIdAsObjectId, currentAcademicYear) {
  const email = normalizedRow['email'];
  const dateOfBirthString = normalizedRow['dateofbirth'];
  const finalDateOfBirth = parseFlexibleDate(dateOfBirthString, 'Date of Birth');
  if (!finalDateOfBirth) {
    throw new Error(`Date of Birth is required and could not be parsed (row ${normalizedRow.originalRowNumber}).`);
  }

  const finalAdmissionDate = parseFlexibleDate(normalizedRow['admissiondate'], 'Admission Date') || new Date();

  let temporaryPassword;
  try {
    temporaryPassword = generateStudentPasswordFromDOB(dateOfBirthString);
  } catch (e) {
    console.warn(`Could not generate password from DOB "${dateOfBirthString}" for row ${normalizedRow.originalRowNumber}. Generating random password.`);
    temporaryPassword = generateRandomPassword(8);
  }

  const hashedPassword = await bcrypt.hash(temporaryPassword, 10);
  let gender = normalizedRow['gender']?.toLowerCase();
  if (!['male', 'female', 'other'].includes(gender)) {
    gender = 'other';
  }

  const isActiveValue = normalizedRow['isactive']?.toLowerCase();
  let isActive = true;
  if (isActiveValue === 'false' || isActiveValue === 'inactive' || isActiveValue === 'no' || isActiveValue === '0') {
    isActive = false;
  }

  const isRTECandidateValue = normalizedRow['isrtcandidate']?.toLowerCase();
  const isRTECandidate = isRTECandidateValue === 'yes' ? 'Yes' : 'No';

  // --- Clean all scientific notation and formatting ---

  // 1. Clean Aadhar Number
  let cleanedAadhaar = (normalizedRow['aadharnumber'] || '').toString().trim();
  if (/e\+/i.test(cleanedAadhaar)) { // Check for scientific notation
    try {
      cleanedAadhaar = BigInt(Number(cleanedAadhaar)).toString();
    } catch (e) {
      console.warn(`Row ${normalizedRow.originalRowNumber}: Failed to convert scientific notation for Aadhaar. Saving as empty.`);
      cleanedAadhaar = '';
    }
  } else { // Not scientific, just clean non-digits
    cleanedAadhaar = cleanedAadhaar.replace(/\D/g, '');
  }

  // 2. Clean Bank Account Number
  let cleanedBankAccountNo = (normalizedRow['bankaccountno'] || '').toString().trim();
  if (/e\+/i.test(cleanedBankAccountNo)) { // Check for scientific notation
    try {
      cleanedBankAccountNo = BigInt(Number(cleanedBankAccountNo)).toString();
    } catch (e) {
      console.warn(`Row ${normalizedRow.originalRowNumber}: Failed to convert scientific notation for Bank Account No. Saving as empty.`);
      cleanedBankAccountNo = '';
    }
  } else { // Not scientific, just clean non-digits
    cleanedBankAccountNo = cleanedBankAccountNo.replace(/\D/g, '');
  }

  // 3. Clean other fields
  const cleanedBankIFSC = (normalizedRow['bankifsc'] || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
  let permanentPincode = (normalizedRow['permanentpincode'] || '').toString().replace(/\D/g, '');
  if (permanentPincode && permanentPincode.length !== 6) {
    permanentPincode = '';
  }

  // --- End of Cleaning ---

  let concessionPercentage = parseInt(normalizedRow['concessionpercentage'] || '0');
  if (isNaN(concessionPercentage) || concessionPercentage < 0 || concessionPercentage > 100) {
    concessionPercentage = 0;
  }

  const firstName = normalizedRow['firstname'] || '';
  const lastName = normalizedRow['lastname'] || '';

  // Handle profile image upload
  let profileImagePath = '';
  if (normalizedRow['profileimage'] && normalizedRow['profileimage'].trim() !== '') {
    let cleanImagePath = normalizedRow['profileimage'].trim();
    if (cleanImagePath.startsWith('?')) {
      cleanImagePath = cleanImagePath.substring(1);
    }

    if (cleanImagePath.startsWith('data:')) {
      console.log(`⚠️ Skipping base64 data URL for student ${userId} (not supported yet)`);
      profileImagePath = '';
    } else {
      console.log(`📸 Processing profile image for student ${userId}: ${cleanImagePath}`);
      try {
        profileImagePath = await copyProfilePicture(cleanImagePath, userId, schoolCode);
        console.log(`✅ Student profile image uploaded successfully: ${profileImagePath}`);
        if (!profileImagePath || profileImagePath.trim() === '') {
          console.error(`❌ copyProfilePicture returned empty path for student ${userId}`);
        }
      } catch (imageError) {
        console.error(`❌ Failed to upload student profile image: ${imageError.message}`);
        profileImagePath = '';
      }
    }
  }

  // --- Main Student Object ---
  const newStudent = {
    _id: new ObjectId(),
    userId,
    schoolCode: schoolCode.toUpperCase(),
    schoolId: schoolIdAsObjectId,
    name: {
      firstName,
      middleName: normalizedRow['middlename'] || '',
      lastName,
      displayName: `${firstName} ${lastName}`.trim()
    },
    email: email,
    password: hashedPassword,
    temporaryPassword: temporaryPassword,
    passwordChangeRequired: true,
    role: 'student',
    contact: {
      primaryPhone: (normalizedRow['primaryphone'] || '').toString().replace(/\D/g, ''),
      secondaryPhone: (normalizedRow['secondaryphone'] || '').toString().replace(/\D/g, ''),
      whatsappNumber: (normalizedRow['whatsappnumber'] || '').toString().replace(/\D/g, ''),
    },
    address: { // This is the correct schema-defined address
      permanent: {
        street: normalizedRow['permanentstreet'] || '',
        area: normalizedRow['permanentarea'] || '',
        city: normalizedRow['permanentcity'] || '',
        state: normalizedRow['permanentstate'] || '',
        country: normalizedRow['permanentcountry'] || 'India',
        pincode: permanentPincode,
        landmark: normalizedRow['permanentlandmark'] || ''
      },
      current: undefined,
      sameAsPermanent: true
    },
    identity: {
      aadharNumber: cleanedAadhaar || '',
      panNumber: normalizedRow['pannumber'] || ''
    },
    profileImage: profileImagePath || null,
    isActive: isActive,
    createdAt: new Date(),
    updatedAt: new Date(),
    schoolAccess: {
      joinedDate: finalAdmissionDate,
      assignedBy: creatingUserIdAsObjectId,
      status: 'active',
      accessLevel: 'full'
    },
    auditTrail: {
      createdBy: creatingUserIdAsObjectId,
      createdAt: new Date()
    },

    // --- 1. CORRECT NESTED studentDetails OBJECT ---
    studentDetails: {
      studentId: userId,
      admissionNumber: normalizedRow['admissionnumber'] || '',
      rollNumber: normalizedRow['rollnumber'] || '',

      academic: {
        currentClass: normalizedRow['currentclass'] || '',
        currentSection: normalizedRow['currentsection'] || '',
        academicYear: currentAcademicYear, // <-- Use the year from school_info
        admissionDate: finalAdmissionDate,
        admissionClass: normalizedRow['admissionclass'] || '',
        enrollmentNo: normalizedRow['admissionnumber'] || '',
        tcNo: normalizedRow['tcnumber'] || '',
        previousSchool: {
          name: normalizedRow['previousschoolname'] || '',
          board: normalizedRow['previousboard'] || '',
          lastClass: normalizedRow['lastclass'] || '',
          tcNumber: normalizedRow['tcnumber'] || '',
          reasonForTransfer: normalizedRow['reasonfortransfer'] || ''
        }
      },

      personal: {
        dateOfBirth: finalDateOfBirth,
        placeOfBirth: normalizedRow['placeofbirth'] || '',
        gender: gender,
        bloodGroup: normalizedRow['bloodgroup'] || '',
        nationality: normalizedRow['nationality'] || 'Indian',
        religion: normalizedRow['religion'] || '',
        religionOther: '',
        caste: normalizedRow['caste'] || '',
        casteOther: '',
        category: normalizedRow['category'] || '',
        categoryOther: '',
        motherTongue: normalizedRow['mothertongue'] || '',
        motherTongueOther: '',
        studentNameKannada: '',
        ageYears: 0,
        ageMonths: 0,
        socialCategory: '',
        socialCategoryOther: '',
        studentCaste: '',
        studentCasteOther: '',
        studentAadhaar: cleanedAadhaar || '',
        studentCasteCertNo: normalizedRow['studentcastecertno'] || '',
        specialCategory: '',
        specialCategoryOther: '',
        belongingToBPL: (normalizedRow['belongingtobpl']?.toLowerCase() === 'yes') ? 'Yes' : 'No',
        bplCardNo: normalizedRow['bplcardno'] || '',
        bhagyalakshmiBondNo: normalizedRow['bhagyalakshmibondno'] || '',
        disability: normalizedRow['disability'] || 'Not Applicable',
        disabilityOther: '',
        isRTECandidate: isRTECandidate
      },

      medical: {
        allergies: (normalizedRow['allergies'] || '').split(',').map(s => s.trim()).filter(Boolean),
        chronicConditions: (normalizedRow['medicalconditions'] || '').split(',').map(s => s.trim()).filter(Boolean),
        medications: (normalizedRow['medications'] || '').split(',').map(s => s.trim()).filter(Boolean),
        emergencyMedicalContact: {
          doctorName: normalizedRow['doctorname'] || '',
          hospitalName: normalizedRow['hospitalname'] || '',
          phone: (normalizedRow['doctorphone'] || '').toString().replace(/\D/g, '')
        },
        lastMedicalCheckup: normalizedRow['lastmedicalcheckup'] ? new Date(normalizedRow['lastmedicalcheckup']) : undefined
      },

      family: {
        father: {
          name: normalizedRow['fathername'] || '',
          nameKannada: '',
          occupation: normalizedRow['fatheroccupation'] || '',
          qualification: normalizedRow['fatherqualification'] || '',
          phone: (normalizedRow['fatherphone'] || '').toString().replace(/\D/g, ''),
          email: normalizedRow['fatheremail']?.toLowerCase() || '',
          aadhaar: normalizedRow['fatheraadhaar'] || '',
          caste: normalizedRow['fathercaste'] || '',
          casteOther: '',
          casteCertNo: normalizedRow['fathercastecertno'] || '',
          workAddress: normalizedRow['fatherworkaddress'] || '',
          annualIncome: 0
        },
        mother: {
          name: normalizedRow['mothername'] || '',
          nameKannada: '',
          occupation: normalizedRow['motheroccupation'] || '',
          qualification: normalizedRow['motherqualification'] || '',
          phone: (normalizedRow['motherphone'] || '').toString().replace(/\D/g, ''),
          email: normalizedRow['motheremail']?.toLowerCase() || '',
          aadhaar: normalizedRow['motheraadhaar'] || '',
          caste: normalizedRow['mothercaste'] || '',
          casteOther: '',
          casteCertNo: normalizedRow['mothercastecertno'] || '',
          workAddress: normalizedRow['motherworkaddress'] || '',
          annualIncome: 0
        },
        guardian: {
          name: normalizedRow['guardianname'] || '',
          relationship: normalizedRow['guardianrelationship'] || '',
          phone: (normalizedRow['guardianphone'] || '').toString().replace(/\D/g, ''),
          email: normalizedRow['guardianemail']?.toLowerCase() || '',
          address: normalizedRow['guardianaddress'] || '',
          isEmergencyContact: false
        },
        siblings: []
      },

      transport: {
        mode: normalizedRow['transportmode'] || '',
        busRoute: normalizedRow['busroute'] || '',
        pickupPoint: normalizedRow['pickuppoint'] || '',
        dropPoint: normalizedRow['droppoint'] || '',
        pickupTime: normalizedRow['pickuptime'] || '',
        dropTime: normalizedRow['droptime'] || ''
      },

      financial: {
        feeCategory: normalizedRow['feecategory'] || '',
        concessionType: normalizedRow['concessiontype'] || '',
        concessionPercentage: concessionPercentage,
        bankDetails: {
          bankName: normalizedRow['bankname'] || '',
          accountNumber: cleanedBankAccountNo,
          ifscCode: cleanedBankIFSC,
          accountHolderName: normalizedRow['accountholdername'] || `${firstName} ${lastName}`.trim()
        }
      }
    }
  };

  return newStudent;
}

// --- CSV Generation (Enhanced) ---
// REPLACE your entire generateCSV function with this one:

// REPLACE your entire generateCSV function with this
function generateCSV(users, role) {
  let headers;
  let rows;

  if (role.toLowerCase() === 'student') {
    headers = getStudentHeadersRobust();

    rows = users.map(user => {
      // --- Define data objects for easy access, handling undefined
      const name = user.name || {};
      const contact = user.contact || {};
      const permanentAddr = user.address?.permanent || {};
      const identity = user.identity || {};
      const sDetails = user.studentDetails || {}; // Main nested object
      const academic = sDetails.academic || {};
      const personal = sDetails.personal || {};
      const family = sDetails.family || {};
      const financial = sDetails.financial || {};
      const bank = financial.bankDetails || user.banking || {};
      const father = family.father || {};

      // --- Helper to format dates ---
      const formatDate = (dateString) => {
        if (!dateString) return '';
        try {
          const date = new Date(dateString);
          if (isNaN(date.getTime())) return '';
          // Format as YYYY-MM-DD
          return date.toISOString().split('T')[0];
        } catch (e) {
          return '';
        }
      };

      // --- Map data directly to headers ---
      const rowData = {
        'User ID': user.userId || '',
        'First Name': name.firstName || '',
        'Last Name': name.lastName || '',
        'Email': user.email || '',
        'Phone Number': contact.primaryPhone || '',
        'Date of Birth': formatDate(personal.dateOfBirth),
        'Gender': personal.gender || '',
        'Blood Group': personal.bloodGroup || '',
        'Enrollment No': academic.enrollmentNo || '',
        'TC No': academic.tcNo || '',
        'Admission to Class': academic.currentClass || '',
        'Section': academic.currentSection || '',
        'Academic Year': academic.academicYear || '',
        'Is RTE Candidate': personal.isRTECandidate || '',
        'Father Name': father.name || '',
        'Permanent Street': permanentAddr.street || '',
        'City/Village/Town': permanentAddr.city || '',
        'Pin Code': permanentAddr.pincode || '',
        'Aadhar Number': identity.aadharNumber || personal.studentAadhaar || '',
        'School Admission Date': formatDate(academic.admissionDate), // Added this back, as it's in the CSV
        'Address': permanentAddr.street ? [permanentAddr.street, permanentAddr.city, permanentAddr.pincode].filter(Boolean).join(', ') : '', // Added this back
        'Bank Name': bank.bankName || '',
        'Bank Account No': bank.accountNumber || '',
        'Bank IFSC Code': bank.ifscCode || '',
        'Nationality': personal.nationality || '',
        'Student Caste Certificate No': personal.studentCasteCertNo || '',
        'Profile Image': user.profileImage || ''
      };

      // Return an array of values in the correct header order
      return headers.map(header => rowData[header] ?? '');
    });

  } else if (role.toLowerCase() === 'teacher') {
    headers = getTeacherHeadersSimplified();
    rows = users.map(user => {

      // --- START OF EXPORT FIX ---
      // 'teachingInfo' should point to 'teacherDetails'
      // 'personal' should point to the flat 'user.personal' object
      const teachingInfo = user.teacherDetails || {};
      const personal = user.personal || {}; // <-- This was the bug
      // --- END OF EXPORT FIX ---

      const name = user.name || {};
      const contact = user.contact || {};
      const address = user.address || {};
      const subjects = teachingInfo.subjects || []; // This now correctly reads user.teacherDetails.subjects
      const rowData = {};

      let fullAddress = '';
      if (typeof user.address === 'string') {
        // Only use if not 'NA' or similar placeholder
        fullAddress = (user.address && user.address.trim() !== '' && user.address.toUpperCase() !== 'NA') ? user.address : '';
      } else if (user.address && typeof user.address === 'object') {
        const currentAddr = user.address.current || {};
        const permanentAddr = user.address.permanent || {};

        const addressParts = [
          currentAddr.street || permanentAddr.street,
          currentAddr.area || permanentAddr.area,
          currentAddr.city || permanentAddr.city,
          currentAddr.state || permanentAddr.state,
          currentAddr.pincode || permanentAddr.pincode
        ]
          .filter(Boolean) // Remove empty values
          .filter(part => part.trim() !== '' && part.toUpperCase() !== 'NA'); // Remove 'NA' or similar placeholders

        fullAddress = addressParts.join(', ');
      }

      headers.forEach(header => {
        let value = '';
        try {
          switch (header) {
            case 'First Name': value = name.firstName || user.firstName || user.first_name || ''; break;
            case 'Last Name': value = name.lastName || user.lastName || user.last_name || ''; break;
            case 'Email': value = user.email || ''; break;
            case 'Date of Birth':
              // This now correctly reads from user.personal.dateOfBirth
              value = personal.dateOfBirth || '';
              if (value) {
                try {
                  value = new Date(value).toISOString().split('T')[0];
                } catch (e) {
                  value = '';
                }
              }
              break;
            case 'Gender':
              // This now correctly reads from user.personal.gender
              value = personal.gender || '';
              break;
            case 'Qualification':
              value = teachingInfo.qualification || '';
              break;
            case 'Experience (Years)':
              value = teachingInfo.experience || '';
              break;
            case 'Subjects Taught':
              // This now correctly reads from user.teacherDetails.subjects
              if (Array.isArray(subjects)) {
                value = subjects.map((s) => {
                  if (typeof s === 'string') {
                    return s;
                  } else if (typeof s === 'object' && s !== null) {
                    return s.subjectName || s.name || s.subject || String(s);
                  } else {
                    return String(s);
                  }
                }).join(', ');
              } else if (typeof subjects === 'string') {
                value = subjects;
              } else {
                value = '';
              }
              break;
            case 'Employee ID':
              value = teachingInfo.employeeId || user.userId || '';
              break;
            case 'Address': value = fullAddress; break;
            case 'Profile Image': value = user.profileImage || user.profilePicture || ''; break;
            default: value = '';
          }
        } catch (e) {
          console.warn(`Error getting ${header} for teacher ${user.userId}:`, e.message);
          value = '';
        }
        rowData[header] = value ?? '';
      });
      return headers.map(header => rowData[header]);
    });

  } else if (role.toLowerCase() === 'admin') {
    // (This is the existing admin logic from your file, preserved)
    headers = getAdminHeaders();
    rows = users.map(user => {
      const adminDetails = user.adminDetails || {};
      const personal = user.personal || {};
      const name = user.name || {};
      const contact = user.contact || {};
      const addressP = user.address?.permanent || {};
      const addressC = user.address?.current || {};
      const identity = user.identity || {};
      const rowData = {};

      headers.forEach(header => {
        let value = '';
        try {
          switch (header) {
            case 'userId': value = user.userId; break;
            case 'firstName': value = name.firstName; break;
            case 'middleName': value = name.middleName; break;
            case 'lastName': value = name.lastName; break;
            case 'email': value = user.email; break;
            case 'primaryPhone': value = contact.primaryPhone; break;
            case 'secondaryPhone': value = contact.secondaryPhone; break;
            case 'whatsappNumber': value = contact.whatsappNumber || ''; break;
            case 'dateOfBirth': value = adminDetails.dateOfBirth ? new Date(adminDetails.dateOfBirth).toISOString().split('T')[0] : ''; break;
            case 'gender': value = adminDetails.gender; break;
            case 'permanentStreet': value = addressP.street; break;
            case 'permanentArea': value = addressP.area; break;
            case 'permanentCity': value = addressP.city; break;
            case 'permanentState': value = addressP.state; break;
            case 'permanentPincode': value = addressP.pincode; break;
            case 'permanentCountry': value = addressP.country; break;
            case 'permanentLandmark': value = addressP.landmark; break;
            case 'sameAsPermanent': value = user.address?.sameAsPermanent === false ? 'FALSE' : 'TRUE'; break;
            case 'currentStreet': value = addressC?.street || ''; break;
            case 'currentArea': value = addressC?.area || ''; break;
            case 'currentCity': value = addressC?.city || ''; break;
            case 'currentState': value = addressC?.state || ''; break;
            case 'currentPincode': value = addressC?.pincode || ''; break;
            case 'currentCountry': value = addressC?.country || ''; break;

            case 'currentLandmark': value = addressC?.landmark || ''; break;
            case 'aadharNumber': value = identity.aadharNumber; break;
            case 'panNumber': value = identity.panNumber; break;
            case 'joiningDate': value = adminDetails.joiningDate ? new Date(adminDetails.joiningDate).toISOString().split('T')[0] : ''; break;
            case 'employeeId': value = adminDetails.employeeId; break;
            case 'adminType': value = adminDetails.adminType; break;
            case 'designation': value = adminDetails.designation || ''; break;
            case 'department': value = adminDetails.department; break;
            case 'permissions_userManagement': value = adminDetails.permissions?.userManagement ? 'TRUE' : 'FALSE'; break;
            case 'permissions_academicManagement': value = adminDetails.permissions?.academicManagement ? 'TRUE' : 'FALSE'; break;
            case 'permissions_feeManagement': value = adminDetails.permissions?.feeManagement ? 'TRUE' : 'FALSE'; break;
            case 'permissions_reportGeneration': value = adminDetails.permissions?.reportGeneration ? 'TRUE' : 'FALSE'; break;
            case 'permissions_systemSettings': value = adminDetails.permissions?.systemSettings ? 'TRUE' : 'FALSE'; break;
            case 'permissions_schoolSettings': value = adminDetails.permissions?.schoolSettings ? 'TRUE' : 'FALSE'; break;
            case 'permissions_dataExport': value = adminDetails.permissions?.dataExport ? 'TRUE' : 'FALSE'; break;
            case 'permissions_auditLogs': value = adminDetails.permissions?.auditLogs ? 'TRUE' : 'FALSE'; break;
            case 'bankName': value = adminDetails.bankDetails?.bankName; break;
            case 'accountNumber': value = adminDetails.bankDetails?.accountNumber; break;
            case 'bankIFSC': value = adminDetails.bankDetails?.ifscCode; break;
            case 'accountHolderName': value = adminDetails.bankDetails?.accountHolderName; break;
            case 'bankBranchName': value = adminDetails.bankDetails?.bankBranchName; break;
            case 'bloodGroup': value = personal.bloodGroup; break;
            case 'nationality': value = personal.nationality; break;
            case 'religion': value = personal.religion; break;
            case 'isActive': value = user.isActive === false ? 'false' : 'true'; break;
            case 'profileImage': value = user.profileImage || ''; break;
            default: value = '';
          }
        } catch (e) { console.warn(`Error getting ${header} for admin ${user.userId}`); }
        rowData[header] = value ?? '';
      });
      return headers.map(header => rowData[header]);
    });

  } else {
    console.warn(`generateCSV called with unsupported role: ${role}`);
    return '';
  }

  // --- This part remains the same ---
  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => {
      const strCell = String(cell ?? '');
      if (strCell.includes('"') || strCell.includes(',') || strCell.includes('\n') || strCell.includes('\r')) {
        return `"${strCell.replace(/"/g, '""')}"`;
      }
      return strCell;
    }).join(','))
  ].join('\n');

  return csvContent;
}
// --- Format User for JSON/Excel Export ---
function formatUserForExport(user, role) {
  // Basic user info
  const formatted = {
    userId: user.userId,
    role: user.role || role, // Ensure role is present
    email: user.email,
    firstName: user.name?.firstName,
    middleName: user.name?.middleName,
    lastName: user.name?.lastName,
    displayName: user.name?.displayName,
    primaryPhone: user.contact?.primaryPhone,
    secondaryPhone: user.contact?.secondaryPhone,
    whatsappNumber: user.contact?.whatsappNumber,
    isActive: user.isActive,
    // Flatten address
    permanentStreet: user.address?.permanent?.street,
    permanentArea: user.address?.permanent?.area,
    permanentCity: user.address?.permanent?.city,
    permanentState: user.address?.permanent?.state,
    permanentPincode: user.address?.permanent?.pincode,
    permanentCountry: user.address?.permanent?.country,
    permanentLandmark: user.address?.permanent?.landmark,
    sameAsPermanent: user.address?.sameAsPermanent,
    currentStreet: user.address?.current?.street,
    currentArea: user.address?.current?.area,
    currentCity: user.address?.current?.city,
    currentState: user.address?.current?.state,
    currentPincode: user.address?.current?.pincode,
    currentCountry: user.address?.current?.country,
    currentLandmark: user.address?.current?.landmark,
    // Flatten identity
    aadharNumber: user.identity?.aadharNumber,
    panNumber: user.identity?.panNumber,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    joiningDate: user.schoolAccess?.joinedDate, // Common joining date
  };

  // Add role-specific flattened details
  if (role === 'student' && user.studentDetails) {
    Object.assign(formatted, {
      dateOfBirth: user.studentDetails.dateOfBirth,
      gender: user.studentDetails.gender,
      admissionNumber: user.studentDetails.admissionNumber,
      rollNumber: user.studentDetails.rollNumber,
      currentClass: user.studentDetails.currentClass,
      currentSection: user.studentDetails.currentSection,
      academicYear: user.studentDetails.academicYear,
      admissionDate: user.studentDetails.admissionDate,
      fatherName: user.studentDetails.fatherName,
      motherName: user.studentDetails.motherName,
      // ... add other relevant flattened studentDetails fields from getStudentHeadersRobust
      guardianName: user.studentDetails.guardianName,
      fatherPhone: user.studentDetails.fatherPhone,
      motherPhone: user.studentDetails.motherPhone,
      fatherEmail: user.studentDetails.fatherEmail,
      motherEmail: user.studentDetails.motherEmail,
      religion: user.studentDetails.religion,
      caste: user.studentDetails.caste,
      category: user.studentDetails.category,
      disability: user.studentDetails.disability,
      isRTECandidate: user.studentDetails.isRTECandidate,
      previousSchoolName: user.studentDetails.previousSchoolName,
      previousBoard: user.studentDetails.previousBoard,
      lastClass: user.studentDetails.lastClass,
      tcNumber: user.studentDetails.tcNumber,
      transportMode: user.studentDetails.transportMode,
      busRoute: user.studentDetails.busRoute,
      pickupPoint: user.studentDetails.pickupPoint,
      feeCategory: user.studentDetails.feeCategory,
      concessionType: user.studentDetails.concessionType,
      concessionPercentage: user.studentDetails.concessionPercentage,
      bankName: user.studentDetails.bankName,
      bankAccountNo: user.studentDetails.bankAccountNo,
      bankIFSC: user.studentDetails.bankIFSC,
      medicalConditions: user.studentDetails.medicalConditions,
      allergies: user.studentDetails.allergies,
      specialNeeds: user.studentDetails.specialNeeds,
      bloodGroup: user.studentDetails.bloodGroup,
      nationality: user.studentDetails.nationality,
      studentCasteCertNo: user.studentDetails.studentCasteCertNo || user.studentCasteCertNo || '',
    });
  } else if (role === 'teacher' && user.teacherDetails) {
    Object.assign(formatted, {
      dateOfBirth: user.teacherDetails.dateOfBirth,
      gender: user.teacherDetails.gender,
      joiningDate: user.teacherDetails.joiningDate, // Use specific joining date if available
      highestQualification: user.teacherDetails.qualification,
      specialization: user.teacherDetails.specialization,
      totalExperience: user.teacherDetails.experience,
      subjects: Array.isArray(user.teacherDetails.subjects) ? user.teacherDetails.subjects.join(', ') : '',
      classTeacherOf: user.teacherDetails.classTeacherOf,
      employeeId: user.teacherDetails.employeeId,
      // ... add other relevant flattened teacherDetails fields from getTeacherHeaders
      bloodGroup: user.teacherDetails.bloodGroup,
      nationality: user.teacherDetails.nationality,
      religion: user.teacherDetails.religion,
      bankName: user.teacherDetails.bankName,
      bankAccountNo: user.teacherDetails.bankAccountNo,
      bankIFSC: user.teacherDetails.bankIFSC,

    });
  } else if (role === 'admin' && user.adminDetails) { // <--- NEW: Admin Export Format
    Object.assign(formatted, {
      dateOfBirth: user.adminDetails.dateOfBirth || user.dateOfBirth, // Use top-level if adminDetails lacks it
      gender: user.adminDetails.gender || user.gender,
      joiningDate: user.adminDetails.joiningDate,
      employeeId: user.adminDetails.employeeId,
      adminType: user.adminDetails.adminType,
      designation: user.adminDetails.designation,
      department: user.adminDetails.department,
      bankName: user.adminDetails.bankDetails?.bankName,
      bankAccountNo: user.adminDetails.bankDetails?.accountNumber,
      bankIFSC: user.adminDetails.bankDetails?.ifscCode,
      accountHolderName: user.adminDetails.bankDetails?.accountHolderName,
      userManagementPermission: user.adminDetails.permissions?.userManagement,
      academicManagementPermission: user.adminDetails.permissions?.academicManagement,
      feeManagementPermission: user.adminDetails.permissions?.feeManagement,
      reportGenerationPermission: user.adminDetails.permissions?.reportGeneration,
      systemSettingsPermission: user.adminDetails.permissions?.systemSettings,
      schoolSettingsPermission: user.adminDetails.permissions?.schoolSettings,
      dataExportPermission: user.adminDetails.permissions?.dataExport,
      auditLogsPermission: user.adminDetails.permissions?.auditLogs,
    });
  }
  // Remove undefined fields to keep export clean
  Object.keys(formatted).forEach(key => formatted[key] === undefined && delete formatted[key]);

  return formatted;
}


// ==================================================================
// END: FILE
// ==================================================================

// Export necessary functions
module.exports = {
  exportUsers: exports.exportUsers,
  importUsers: exports.importUsers,
  generateTemplate: exports.generateTemplate
};